"""Publication rules for frontend assets; signing/configuration files are never web assets."""
from pathlib import Path, PurePosixPath
import json
import re

ALLOWED_SUFFIXES = {'.html', '.js', '.mjs', '.css', '.json', '.svg', '.ico', '.png', '.jpg', '.jpeg',
                    '.webp', '.gif', '.avif', '.woff', '.woff2', '.ttf', '.otf', '.txt', '.webmanifest'}
PRIVATE_PARTS = {'private', 'runtime', 'node_modules', 'tests', 'test-results', 'playwright-report',
                 'signing', 'client-signing', '.git', '.github'}
# No private-key header belongs in a published application asset. Matching the
# header also catches traditional encrypted PEMs with Proc-Type/DEK-Info lines.
PRIVATE_KEY = re.compile(rb'-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----')


def validate_frontend_tree(root: Path) -> dict:
    root = Path(root).resolve()
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('frontend publication refuses symbolic links')
        relative = PurePosixPath(path.relative_to(root).as_posix())
        if any(part.lower() in PRIVATE_PARTS or part.startswith('.') for part in relative.parts):
            raise ValueError('private or diagnostic directory in frontend assets')
        if path.is_file():
            if path.suffix.lower() not in ALLOWED_SUFFIXES or path.name.lower().startswith('.env'):
                raise ValueError('unexpected frontend asset type; refusing upload')
            if PRIVATE_KEY.search(path.read_bytes()):
                raise ValueError('private key block in frontend assets; refusing upload')
    report = json.loads((root / 'react-bundle-audit.json').read_text())
    if (report.get('framework') != 'react' or report.get('react_module_count', 0) < 1
            or report.get('legacy_vue_module_count') != 0):
        raise ValueError('frontend must be React without legacy Vue runtime modules')
    return report
