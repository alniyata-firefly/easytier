#!/usr/bin/env python3
"""Run the opt-in Rust socket lab entirely inside disposable net namespaces.

Usage: python3 script/test-uplink-netns.py --test-binary /path/to/easytier-test-binary
No named namespace, persistent interface, host route, or firewall rule is used.
"""

import argparse
import ipaddress
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import tempfile


def command(*arguments):
    return subprocess.run(arguments, check=True, text=True, capture_output=True)


def read_line_with_deadline(stream, seconds=5):
    selector = selectors.DefaultSelector()
    selector.register(stream, selectors.EVENT_READ)
    try:
        if not selector.select(seconds):
            raise RuntimeError("peer setup timed out")
        line = stream.readline()
        if not line:
            raise RuntimeError("peer exited during setup")
        return json.loads(line)
    finally:
        selector.close()


def forbidden_egress_markers(capture_path, forbidden_ifindex, markers):
    """Inspect tcpdump's cooked-v2 records without external parser packages."""
    data = Path(capture_path).read_bytes()
    endian = {b"\xd4\xc3\xb2\xa1": "<", b"\xa1\xb2\xc3\xd4": ">", b"\x4d\x3c\xb2\xa1": "<", b"\xa1\xb2\x3c\x4d": ">"}.get(data[:4])
    if endian is None or len(data) < 24:
        raise RuntimeError("unrecognized isolated lab packet capture")
    link_type = struct.unpack_from(endian + "I", data, 20)[0]
    if link_type != 276:  # DLT_LINUX_SLL2 carries an explicit interface index.
        return {"verified": False, "reason": "capture format has no interface indices", "leaked_markers": []}
    offset = 24
    leaks = []
    while offset < len(data):
        if offset + 16 > len(data):
            raise RuntimeError("truncated lab packet capture header")
        captured = struct.unpack_from(endian + "I", data, offset + 8)[0]
        offset += 16
        packet = data[offset:offset + captured]
        if len(packet) != captured:
            raise RuntimeError("truncated lab packet capture data")
        offset += captured
        if len(packet) >= 20 and struct.unpack_from("!I", packet, 4)[0] == forbidden_ifindex and packet[10] == 4:
            leaks.extend(marker for marker in markers if marker.encode() in packet[20:])
    return {"verified": True, "forbidden_ifindex": forbidden_ifindex, "leaked_markers": leaks}


def peer():
    print(json.dumps({"namespace": os.readlink("/proc/self/ns/net")}), flush=True)
    if sys.stdin.readline().strip() != "go":
        raise RuntimeError("missing isolated lab setup acknowledgement")
    selector = selectors.DefaultSelector()
    sockets = []
    for family, address, udp_port, tcp_port in [
        (socket.AF_INET, "198.18.0.2", 39040, 39041),
        (socket.AF_INET6, "fd69:6c61:6201::2", 39046, 39047),
    ]:
        for kind, port in [(socket.SOCK_DGRAM, udp_port), (socket.SOCK_STREAM, tcp_port)]:
            listener = socket.socket(family, kind)
            if family == socket.AF_INET6:
                listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            listener.bind((address, port))
            if kind == socket.SOCK_STREAM:
                listener.listen(8)
            listener.setblocking(False)
            selector.register(listener, selectors.EVENT_READ, ("udp" if kind == socket.SOCK_DGRAM else "listen", family))
            sockets.append(listener)
    control = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    control.bind(("198.18.0.2", 39049))
    selector.register(control, selectors.EVENT_READ, ("control", socket.AF_INET))
    sockets.append(control)
    print(json.dumps({"ready": True}), flush=True)
    while True:
        for key, _ in selector.select(1):
            kind, family = key.data
            listener = key.fileobj
            if kind == "control":
                data, source = listener.recvfrom(1024)
                request = json.loads(data)["connect_tcp"]
                target = request["target"]
                ipv4 = ipaddress.ip_address(target).version == 4
                source_ip = "198.18.0.2" if ipv4 else "fd69:6c61:6201::2"
                try:
                    with socket.socket(socket.AF_INET if ipv4 else socket.AF_INET6, socket.SOCK_STREAM) as connection:
                        connection.settimeout(3)
                        connection.bind((source_ip, 0))
                        connection.connect((target, request["port"]))
                        marker = request["marker"].encode("ascii")
                        connection.sendall(marker)
                        reply = connection.recv(len(marker))
                        if reply != marker:
                            raise RuntimeError("reverse TCP echo differed")
                    listener.sendto(b"OK:" + marker, source)
                    print(json.dumps({"event": "reverse_tcp", "family": 4 if ipv4 else 6, "source": source_ip, "target": target,
                        "path_allowed": target in ["10.203.0.1", "10.204.0.1", "fd69:6c61:6200::1", "fd69:6c61:6202::1"], "marker": request["marker"]}), flush=True)
                except Exception as error:
                    listener.sendto(("ERR:" + repr(error)).encode(), source)
                continue
            if kind == "listen":
                connection, source = listener.accept()
                connection.settimeout(2)
                with connection:
                    data = connection.recv(1024)
                    connection.sendall(data)
            else:
                data, source = listener.recvfrom(1024)
                # Ensure the native receiver has entered Pending before a
                # reply arrives; immediate loopback-speed echoes can hide lost
                # readiness registrations in a socket fan-in implementation.
                time.sleep(0.025)
                listener.sendto(data, source)
            expected = "10.203.0.1" if family == socket.AF_INET else "fd69:6c61:6200::1"
            print(json.dumps({"event": "echo", "transport": "tcp" if kind == "listen" else "udp", "family": 4 if family == socket.AF_INET else 6,
                "source": source[0], "path_allowed": ipaddress.ip_address(source[0]) == ipaddress.ip_address(expected), "marker": data.decode("ascii", "replace")}), flush=True)


def inside(arguments):
    original_namespace = os.environ["EASYTIER_UPLINK_LAB_ORIGINAL_NS"]
    namespace = os.readlink("/proc/self/ns/net")
    if namespace == original_namespace:
        raise RuntimeError("refusing to configure the original host namespace")
    peer_process = None
    peer_events = []
    reader = None
    test = None
    capture = None
    started = time.time()
    try:
        peer_process = subprocess.Popen(["unshare", "--net", sys.executable, __file__, "--peer"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        peer_namespace = read_line_with_deadline(peer_process.stdout)["namespace"]
        if peer_namespace in [namespace, original_namespace]:
            raise RuntimeError("peer namespace was not isolated")
        command("ip", "link", "set", "lo", "up")
        command("ip", "link", "add", "eth0", "type", "veth", "peer", "name", "peer0")
        command("ip", "link", "set", "peer0", "netns", str(peer_process.pid))
        command("ip", "address", "add", "10.203.0.1/24", "dev", "eth0")
        command("ip", "-6", "address", "add", "fd69:6c61:6200::1/64", "dev", "eth0", "nodad")
        command("ip", "link", "set", "eth0", "up")
        peer_ip = ["nsenter", "--target", str(peer_process.pid), "--net", "ip"]
        command(*peer_ip, "link", "set", "lo", "up")
        command(*peer_ip, "link", "set", "peer0", "up")
        command(*peer_ip, "address", "add", "10.203.0.2/24", "dev", "peer0")
        command(*peer_ip, "-6", "address", "add", "fd69:6c61:6200::2/64", "dev", "peer0", "nodad")
        command(*peer_ip, "address", "add", "198.18.0.2/32", "dev", "lo")
        command(*peer_ip, "-6", "address", "add", "fd69:6c61:6201::2/128", "dev", "lo", "nodad")
        command("ip", "link", "add", "eth1", "type", "veth", "peer", "name", "peer1")
        command("ip", "link", "set", "peer1", "netns", str(peer_process.pid))
        command("ip", "address", "add", "10.204.0.1/24", "dev", "eth1")
        command("ip", "-6", "address", "add", "fd69:6c61:6202::1/64", "dev", "eth1", "nodad")
        command("ip", "link", "set", "eth1", "up")
        command(*peer_ip, "address", "add", "10.204.0.2/24", "dev", "peer1")
        command(*peer_ip, "-6", "address", "add", "fd69:6c61:6202::2/64", "dev", "peer1", "nodad")
        command(*peer_ip, "link", "set", "peer1", "up")
        command("ip", "link", "add", "wg0", "type", "dummy")
        command("ip", "address", "add", "10.203.77.1/24", "dev", "wg0")
        command("ip", "-6", "address", "add", "fd69:dead::1/64", "dev", "wg0", "nodad")
        command("ip", "link", "set", "wg0", "up")
        command("ip", "route", "add", "198.18.0.2/32", "via", "10.203.0.2", "dev", "eth0", "metric", "100")
        command("ip", "route", "add", "198.18.0.2/32", "dev", "wg0", "metric", "1")
        command("ip", "route", "add", "198.18.0.2/32", "via", "10.204.0.2", "dev", "eth1", "metric", "200")
        command("ip", "-6", "route", "add", "fd69:6c61:6201::2/128", "via", "fd69:6c61:6200::2", "dev", "eth0", "metric", "100")
        command("ip", "-6", "route", "add", "fd69:6c61:6201::2/128", "dev", "wg0", "metric", "1")
        command("ip", "-6", "route", "add", "fd69:6c61:6201::2/128", "via", "fd69:6c61:6202::2", "dev", "eth1", "metric", "200")
        # Only this disposable namespace is changed; competing VPN routes would
        # otherwise cause strict reverse-path filtering to reject valid replies.
        for interface in ["all", "default", "eth0", "eth1"]:
            Path(f"/proc/sys/net/ipv4/conf/{interface}/rp_filter").write_text("0\n")
        peer_process.stdin.write("go\n")
        peer_process.stdin.flush()
        if read_line_with_deadline(peer_process.stdout) != {"ready": True}:
            raise RuntimeError("peer echo sockets did not start")

        def collect_peer():
            for line in peer_process.stdout:
                peer_events.append(json.loads(line))

        reader = threading.Thread(target=collect_peer, daemon=True)
        reader.start()
        if shutil.which("tcpdump"):
            capture = subprocess.Popen(["tcpdump", "-U", "-n", "-i", "any", "-w", str(Path(arguments.proof).with_suffix(".pcap"))], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(0.1)
        if arguments.oracle:
            results = []
            ifindex = socket.if_nametoindex("eth0")
            for method in ["pktinfo_only", "bind_to_device", "unicast_if"]:
                with socket.socket(socket.AF_INET6, socket.SOCK_DGRAM) as probe:
                    probe.settimeout(1)
                    if method == "bind_to_device":
                        probe.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, b"eth0\x00")
                    if method == "unicast_if":
                        probe.setsockopt(socket.IPPROTO_IPV6, 76, struct.pack("!I", ifindex))
                    probe.bind(("::", 0))
                    marker = ("oracle-" + method).encode()
                    pktinfo = socket.inet_pton(socket.AF_INET6, "fd69:6c61:6200::1") + struct.pack("=I", ifindex)
                    probe.sendmsg([marker], [(socket.IPPROTO_IPV6, socket.IPV6_PKTINFO, pktinfo)], 0, ("fd69:6c61:6201::2", 39046))
                    try:
                        reply, address = probe.recvfrom(1024)
                        echoed = reply == marker
                    except TimeoutError:
                        echoed = False
                    results.append({"method": method, "ifindex": ifindex, "pktinfo_hex": pktinfo.hex(), "echoed": echoed})
            proof = {"status": "PASS" if next(result for result in results if result["method"] == "bind_to_device")["echoed"] else "FAIL", "oracle_results": results, "peer_events": peer_events, "host_routes_firewall_modified": False}
            Path(arguments.proof).write_text(json.dumps(proof, indent=2) + "\n")
            print(json.dumps(proof), flush=True)
            return
        environment = os.environ.copy()
        environment["EASYTIER_UPLINK_LAB"] = "1"
        test = subprocess.run([arguments.test_binary, "socket::uplink_lab_tests::allowed_uplink_survives_competing_vpn_routes_and_ipv6_loss", "--exact", "--ignored", "--nocapture", "--test-threads=1"], env=environment, capture_output=True, text=True, timeout=45)
        print(test.stdout, end="")
        print(test.stderr, end="", file=sys.stderr)
        if test.returncode:
            raise RuntimeError(f"Rust namespace integration test exited {test.returncode}")
        if "1 passed" not in test.stdout:
            raise RuntimeError("the expected integration test did not run")
        time.sleep(0.1)
        expected_markers = {"allowed-udp4-eth0", "allowed-udp6-eth0", "allowed-tcp4-eth0", "allowed-tcp6-eth0", "ipv4-after-ipv6-loss", "reverse-tcp4-eth0", "reverse-tcp4-eth1", "reverse-tcp6-eth0", "reverse-tcp6-eth1"}
        actual_markers = {event.get("marker") for event in peer_events}
        if actual_markers != expected_markers or not all(event.get("path_allowed") for event in peer_events):
            raise RuntimeError(f"unexpected peer data/source: {peer_events!r}")
        capture_verification = {"verified": False, "reason": "tcpdump unavailable", "leaked_markers": []}
        if capture is not None:
            capture.send_signal(signal.SIGINT)
            capture.wait(timeout=3)
            capture = None
            capture_verification = forbidden_egress_markers(Path(arguments.proof).with_suffix(".pcap"), socket.if_nametoindex("wg0"), expected_markers)
            if capture_verification["leaked_markers"]:
                raise RuntimeError(f"allowed traffic escaped through wg0: {capture_verification!r}")
        proof = {"status": "PASS", "original_namespace": original_namespace, "lab_namespace": namespace, "peer_namespace": peer_namespace,
            "elapsed_seconds": round(time.time() - started, 3), "host_routes_firewall_modified": False, "named_namespaces_created": False, "lab_rp_filter_disabled": True,
            "peer_events": peer_events, "test_stdout": test.stdout, "capture_verification": capture_verification}
        Path(arguments.proof).write_text(json.dumps(proof, indent=2) + "\n")
        print(json.dumps({"status": "PASS", "proof": arguments.proof, "peer_echoes": len(peer_events)}))
    except Exception as error:
        proof = {"status": "FAIL", "error": str(error), "peer_events": peer_events,
            "test_stdout": getattr(test, "stdout", None), "test_stderr": getattr(test, "stderr", None),
            "host_routes_firewall_modified": False, "lab_namespace": namespace,
            "lab_links": command("ip", "-s", "-j", "link").stdout,
            "lab_route4": command("ip", "-j", "route").stdout,
            "lab_route6": command("ip", "-6", "-j", "route").stdout,
            "lab_rp_filter": {name: path.read_text().strip() if path.exists() else None for name in ["all", "default", "eth0", "eth1"] for path in [Path(f"/proc/sys/net/ipv4/conf/{name}/rp_filter")]}}
        failure_path = Path(arguments.proof).with_name(Path(arguments.proof).stem + "-failure.json")
        failure_path.write_text(json.dumps(proof, indent=2) + "\n")
        print(json.dumps({"status": "FAIL", "proof": str(failure_path), "peer_events": peer_events}), flush=True)
        raise
    finally:
        if capture is not None:
            capture.send_signal(signal.SIGINT)
            try:
                capture.wait(timeout=3)
            except subprocess.TimeoutExpired:
                capture.kill()
                capture.wait()
        if peer_process is not None:
            peer_process.terminate()
            try:
                peer_process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                peer_process.kill()
                peer_process.wait()
            if reader is not None:
                reader.join(timeout=1)
        # Neither namespace is named/persisted: the child exits, then the outer
        # isolated process exits, releasing all interfaces and routes together.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-binary")
    parser.add_argument("--proof", help="write the result JSON here; default is a unique temporary file")
    parser.add_argument("--inside", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--peer", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--oracle", action="store_true", help="compare Python IPv6 PKTINFO with strict socket binding in the same isolated lab")
    arguments = parser.parse_args()
    if arguments.peer:
        peer()
        return
    if not arguments.test_binary:
        parser.error("--test-binary is required")
    if arguments.proof is None:
        descriptor, arguments.proof = tempfile.mkstemp(prefix="easytier-uplink-lab-", suffix=".json")
        os.close(descriptor)
    arguments.proof = str(Path(arguments.proof).resolve())
    Path(arguments.proof).parent.mkdir(parents=True, exist_ok=True)
    arguments.test_binary = str(Path(arguments.test_binary).resolve(strict=True))
    for tool in ["unshare", "nsenter", "ip"]:
        if not shutil.which(tool):
            raise RuntimeError(f"required lab tool unavailable: {tool}")
    if arguments.inside:
        inside(arguments)
    else:
        os.environ["EASYTIER_UPLINK_LAB_ORIGINAL_NS"] = os.readlink("/proc/self/ns/net")
        command = ["unshare", "--net", sys.executable, __file__, "--inside", "--test-binary", arguments.test_binary, "--proof", arguments.proof]
        if arguments.oracle:
            command.append("--oracle")
        os.execvp("unshare", command)


if __name__ == "__main__":
    main()
