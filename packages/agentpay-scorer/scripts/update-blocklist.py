#!/usr/bin/env python3
"""Extract EVM digital-currency identifiers from OFAC's current published SDN file."""
import datetime
import hashlib
import json
import pathlib
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

url = 'https://sanctionslistservice.ofac.treas.gov/api/download/sdn.xml'
raw = pathlib.Path(sys.argv[1]).read_bytes() if len(sys.argv) > 1 else urllib.request.urlopen(url, timeout=60).read()
root = ET.fromstring(raw)
entries = {}
for item in root.iter():
    if item.tag.rsplit('}', 1)[-1] != 'id':
        continue
    fields = {c.tag.rsplit('}', 1)[-1]: c.text or '' for c in item}
    address = fields.get('idNumber', '')
    if fields.get('idType', '').startswith('Digital Currency Address') and re.fullmatch(r'0x[0-9a-fA-F]{40}', address):
        entries[address.lower()] = {'address': address.lower(), 'kind': fields['idType']}
if not entries:
    raise SystemExit('No EVM addresses found; refusing to replace the snapshot')
out = pathlib.Path(__file__).resolve().parents[1] / 'data' / 'blocklist.json'
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps({'source': url, 'retrievedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'sha256': hashlib.sha256(raw).hexdigest(), 'addresses': sorted(entries.values(), key=lambda x: x['address'])}, indent=2) + '\n')
print(f'Saved {len(entries)} EVM addresses')
