import { strFromU8, unzipSync, yaml } from '../lib.js';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function chunks(bytes) {
    if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) throw new Error('Invalid PNG character card');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const output = [];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset, false);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        const end = dataEnd + 4;
        if (end > bytes.length) throw new Error('Corrupted PNG character card');
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        output.push({ start: offset, end, type, dataStart, dataEnd });
        offset = end;
        if (type === 'IEND') return output;
    }
    throw new Error('PNG is missing IEND');
}

function keyword(bytes, chunk) {
    let end = chunk.dataStart;
    while (end < chunk.dataEnd && bytes[end] !== 0) end += 1;
    return new TextDecoder('latin1').decode(bytes.subarray(chunk.dataStart, end)).toLowerCase();
}

function decodeCard(value) {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
}

function encodeCard(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8_192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
    }
    return btoa(binary);
}

function crc32(bytes) {
    let crc = 0xFFFF_FFFF;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB8_8320 : 0);
    }
    return (crc ^ 0xFFFF_FFFF) >>> 0;
}

function textChunk(name, value) {
    const type = new TextEncoder().encode('tEXt');
    const nameBytes = new TextEncoder().encode(name);
    const valueBytes = new TextEncoder().encode(value);
    const payload = new Uint8Array(nameBytes.length + valueBytes.length + 1);
    payload.set(nameBytes);
    payload.set(valueBytes, nameBytes.length + 1);
    const crcInput = new Uint8Array(type.length + payload.length);
    crcInput.set(type);
    crcInput.set(payload, type.length);
    const result = new Uint8Array(payload.length + 12);
    const view = new DataView(result.buffer);
    view.setUint32(0, payload.length, false);
    result.set(type, 4);
    result.set(payload, 8);
    view.setUint32(payload.length + 8, crc32(crcInput), false);
    return result;
}

export function readPngCard(bytes) {
    let legacy;
    let v3;
    for (const chunk of chunks(bytes)) {
        if (chunk.type !== 'tEXt') continue;
        const name = keyword(bytes, chunk);
        if (name !== 'chara' && name !== 'ccv3') continue;
        const value = new TextDecoder('latin1').decode(bytes.subarray(chunk.dataStart + name.length + 1, chunk.dataEnd));
        if (name === 'ccv3') v3 = value;
        else legacy = value;
    }
    if (!v3 && !legacy) throw new Error('PNG does not contain character metadata');
    return decodeCard(v3 ?? legacy);
}

export function writePngCard(bytes, card) {
    const additions = [
        textChunk('chara', encodeCard(card)),
        textChunk('ccv3', encodeCard({ ...card, spec: 'chara_card_v3', spec_version: '3.0' })),
    ];
    const parts = [bytes.subarray(0, 8)];
    for (const chunk of chunks(bytes)) {
        if (chunk.type === 'IEND') parts.push(...additions);
        if (chunk.type === 'tEXt' && ['chara', 'ccv3'].includes(keyword(bytes, chunk))) continue;
        parts.push(bytes.subarray(chunk.start, chunk.end));
    }
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

export async function readCharacterCard(file) {
    const format = file.name.split('.').pop()?.toLowerCase();
    if (format === 'json') return JSON.parse(await file.text());
    if (format === 'yaml' || format === 'yml') {
        const source = yaml.parse(await file.text());
        return { name: source.name, description: source.context, first_mes: source.greeting };
    }
    if (format === 'png') return readPngCard(new Uint8Array(await file.arrayBuffer()));
    if (format === 'charx') {
        const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: entry => entry.name === 'card.json' });
        if (!archive['card.json']) throw new Error('CharX is missing card.json');
        return JSON.parse(strFromU8(archive['card.json']));
    }
    throw new Error(`Unsupported character format: ${format}`);
}
