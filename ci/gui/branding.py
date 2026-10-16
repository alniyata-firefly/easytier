"""Portable PE/ICO resource inspection adapted from the release validation tools."""
import hashlib
import struct

def sha(data):
    return hashlib.sha256(data).hexdigest()


def ico_images(data):
    reserved, kind, count = struct.unpack_from('<HHH', data)
    if (reserved, kind) != (0, 1) or not count:
        raise RuntimeError('Invalid source ICO')
    result = []
    for i in range(count):
        width, height, colors, reserved, planes, depth, size, offset = struct.unpack_from('<BBBBHHII', data, 6 + i * 16)
        image = data[offset:offset + size]
        if len(image) != size:
            raise RuntimeError('Truncated source ICO')
        result.append({'width': width or 256, 'height': height or 256, 'bytes': size,
                       'sha256': sha(image), 'bit_depth': depth})
    return result


def pe_resources(data):
    pe = struct.unpack_from('<I', data, 0x3c)[0]
    if data[pe:pe + 4] != b'PE\0\0':
        raise RuntimeError('Invalid PE')
    section_count = struct.unpack_from('<H', data, pe + 6)[0]
    optional_size = struct.unpack_from('<H', data, pe + 20)[0]
    optional = pe + 24
    magic = struct.unpack_from('<H', data, optional)[0]
    directory_offset = optional + (112 if magic == 0x20b else 96)
    resource_rva, resource_size = struct.unpack_from('<II', data, directory_offset + 16)
    sections = []
    for i in range(section_count):
        start = optional + optional_size + i * 40
        size, rva, raw_size, raw_offset = struct.unpack_from('<IIII', data, start + 8)
        sections.append((rva, max(size, raw_size), raw_offset, raw_size))

    def offset(rva, size):
        for begin, span, raw, raw_size in sections:
            delta = rva - begin
            if 0 <= delta and delta + size <= raw_size:
                return raw + delta
        raise RuntimeError('Resource RVA is outside raw PE sections')

    root = offset(resource_rva, resource_size)
    result = []

    def name(value):
        if not value & 0x80000000:
            return value
        pos = root + (value & 0x7fffffff)
        count = struct.unpack_from('<H', data, pos)[0]
        return data[pos + 2:pos + 2 + count * 2].decode('utf-16-le')

    def walk(relative, path):
        if len(path) > 4 or relative >= resource_size:
            raise RuntimeError('Invalid or cyclic PE resource tree')
        pos = root + relative
        named, numbered = struct.unpack_from('<HH', data, pos + 12)
        for i in range(named + numbered):
            key, child = struct.unpack_from('<II', data, pos + 16 + i * 8)
            current = path + [name(key)]
            if child & 0x80000000:
                walk(child & 0x7fffffff, current)
            else:
                rva, size, codepage, reserved = struct.unpack_from('<IIII', data, root + child)
                begin = offset(rva, size)
                result.append((current, data[begin:begin + size]))
    walk(0, [])
    return result


def verify_icons(binary, expected):
    resources = pe_resources(binary)
    icons = {(path[1], path[2]): image for path, image in resources if len(path) == 3 and path[0] == 3}
    groups = [(path, value) for path, value in resources if len(path) == 3 and path[0] == 14]
    expected_hashes = sorted(item['sha256'] for item in expected)
    matches = []
    for path, group in groups:
        reserved, kind, count = struct.unpack_from('<HHH', group)
        if (reserved, kind) != (0, 1):
            continue
        entries = []
        for i in range(count):
            w, h, colors, reserved, planes, depth, size, resource_id = struct.unpack_from('<BBBBHHIH', group, 6 + 14 * i)
            payload = icons.get((resource_id, path[2]))
            if payload is None or len(payload) < size:
                raise RuntimeError('PE group icon refers to a missing or truncated icon resource')
            # NSIS updates icons inside its MUI stub while retaining the old
            # resource allocation. The group declares the image length; the
            # remaining allocation must be zero padding, never stale image data.
            padding = payload[size:]
            if any(padding):
                raise RuntimeError('PE icon resource contains unexpected nonzero trailing allocation')
            entries.append({'resource_id': resource_id, 'width': w or 256, 'height': h or 256,
                            'bytes': size, 'sha256': sha(payload[:size]),
                            'resource_storage_bytes': len(payload), 'zero_padding_bytes': len(padding)})
        if sorted(item['sha256'] for item in entries) == expected_hashes:
            matches.append({'group_resource_path': path, 'images': entries})
    if not matches:
        raise RuntimeError('Actual PE icon resource group does not match all frozen canonical ICO images')
    if len(matches) != len(groups):
        raise RuntimeError('PE contains an additional noncanonical group icon')
    return matches
