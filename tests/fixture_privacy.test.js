import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { expect, test } from '@jest/globals';

const fixtures = ['paramount-segmented-anonymized.mpd', 'paramount-indexed-anonymized.mpd'];
const widevine = 'edef8ba979d64acea3c827dcd51d21ed';
const playready = '9a04f07998404286ab92e65be0885f95';
const syntheticKid = /^00000000-0000-4000-8000-00000000000[1-4]$/;
const parse = text => new DOMParser().parseFromString(text, 'application/xml');
const bytes = kid => Buffer.from(kid.replaceAll('-', ''), 'hex');

function playreadyKid(value) {
  const kid = Buffer.from(value, 'base64');
  for (const [start, end] of [[0, 4], [4, 6], [6, 8]]) kid.subarray(start, end).reverse();
  const hex = kid.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function validatePlayready(data, declaredKids) {
  expect(data.readUInt32LE(0)).toBe(data.length);
  expect(data.readUInt16LE(4)).toBe(1); // One WRMHEADER record.
  expect(data.readUInt16LE(6)).toBe(1);
  expect(data.readUInt16LE(8)).toBe(data.length - 10);
  const doc = parse(data.subarray(10).toString('utf16le'));
  expect(doc.querySelector('parsererror')).toBeNull();
  // An allowlist also prevents account/content references hidden in encoded XML.
  const names = Array.from(doc.querySelectorAll('*')).map(node => node.localName);
  expect(names).toEqual(['WRMHEADER', 'DATA', 'PROTECTINFO', 'KEYLEN', 'ALGID', 'KID', 'CHECKSUM',
    ...(doc.querySelector('LA_URL') ? ['LA_URL'] : [])]);
  expect(doc.querySelector('WRMHEADER').getAttribute('version')).toBe('4.0.0.0');
  expect(doc.querySelector('KEYLEN').textContent).toBe('16');
  expect(doc.querySelector('ALGID').textContent).toBe('AESCTR');
  expect(doc.querySelector('CHECKSUM').textContent).toBe('AAAAAAAAAAA=');
  expect(declaredKids).toContain(playreadyKid(doc.querySelector('KID').textContent));
  if (doc.querySelector('LA_URL')) {
    expect(doc.querySelector('LA_URL').textContent).toBe('https://license.example.invalid/playready');
  }
}

test.each(fixtures)('%s contains synthetic asset paths and protection identifiers', name => {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  expect(text).toContain('Anonymized capture-derived fixture');
  const doc = parse(text);
  expect(doc.querySelector('parsererror')).toBeNull();
  const kids = Array.from(doc.querySelectorAll('ContentProtection'))
    .map(node => node.getAttribute('cenc:default_KID')).filter(Boolean);
  expect(kids.length).toBeGreaterThan(0);
  for (const kid of kids) expect(kid).toMatch(syntheticKid);
  for (const node of doc.querySelectorAll('BaseURL, SegmentTemplate')) {
    const values = node.localName === 'BaseURL' ? [node.textContent.trim()]
      : [node.getAttribute('media'), node.getAttribute('initialization')].filter(Boolean);
    for (const value of values) {
      expect(value).toMatch(/^(?:SAMPLE_[^?#]+|en-US\.vtt|\$RepresentationID\$\/tile_\$Number\$\.jpg)$/);
      for (const id of value.matchAll(/_(\d{5,})(?=[_.])/g)) expect(id[1]).toMatch(/^200000[1-9]$/);
    }
  }
});

test.each(fixtures)('%s has structurally valid synthetic PSSH and PlayReady payloads', name => {
  const doc = parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
  const kids = [...new Set(Array.from(doc.querySelectorAll('ContentProtection'))
    .map(node => node.getAttribute('cenc:default_KID')).filter(Boolean))];
  const nodes = Array.from(doc.querySelectorAll('*')).filter(node => ['pssh', 'pro'].includes(node.localName));
  expect(nodes.length).toBeGreaterThan(0);
  for (const node of nodes) {
    const data = Buffer.from(node.textContent.trim(), 'base64');
    if (node.localName === 'pro') {
      validatePlayready(data, kids);
      continue;
    }
    expect(data.readUInt32BE(0)).toBe(data.length);
    expect(data.subarray(4, 8).toString('ascii')).toBe('pssh');
    expect(data.readUInt32BE(8)).toBe(0);
    expect(data.readUInt32BE(28)).toBe(data.length - 32);
    const system = data.subarray(12, 28).toString('hex');
    expect([widevine, playready]).toContain(system);
    if (system === playready) validatePlayready(data.subarray(32), kids);
    else {
      // Only declared synthetic KIDs, with no provider, content ID or license data.
      expect(data.subarray(32)).toEqual(Buffer.concat(kids.map(kid => Buffer.concat([Buffer.from([0x12, 0x10]), bytes(kid)]))));
    }
  }
});
