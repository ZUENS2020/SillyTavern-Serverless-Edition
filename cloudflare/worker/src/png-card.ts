import { Buffer } from 'node:buffer';

import { crc32 } from 'crc';

import { HttpError } from './http';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

interface PngChunk {
    start: number;
    end: number;
    type: string;
    dataStart: number;
    dataEnd: number;
}

function isPng(bytes: Uint8Array): boolean {
    return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function chunks(bytes: Uint8Array): PngChunk[] {
    if (!isPng(bytes)) throw new HttpError(400, 'Invalid PNG character card');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const output: PngChunk[] = [];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset, false);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        const end = dataEnd + 4;
        if (end > bytes.length) throw new HttpError(400, 'Corrupted PNG character card');
        const type = String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0);
        output.push({ start: offset, end, type, dataStart, dataEnd });
        offset = end;
        if (type === 'IEND') return output;
    }
    throw new HttpError(400, 'PNG is missing IEND');
}

function textKeyword(bytes: Uint8Array, chunk: PngChunk): string {
    let separator = chunk.dataStart;
    while (separator < chunk.dataEnd && bytes[separator] !== 0) separator += 1;
    return new TextDecoder('latin1').decode(bytes.subarray(chunk.dataStart, separator)).toLowerCase();
}

export function readPngCharacter(bytes: Uint8Array): Record<string, unknown> {
    let encoded: string | undefined;
    let v3Encoded: string | undefined;
    for (const chunk of chunks(bytes)) {
        if (chunk.type !== 'tEXt') continue;
        const keyword = textKeyword(bytes, chunk);
        if (keyword !== 'chara' && keyword !== 'ccv3') continue;
        const valueStart = chunk.dataStart + keyword.length + 1;
        const value = new TextDecoder('latin1').decode(bytes.subarray(valueStart, chunk.dataEnd));
        if (keyword === 'ccv3') v3Encoded = value;
        else encoded = value;
    }
    const selected = v3Encoded ?? encoded;
    if (!selected) throw new HttpError(400, 'PNG does not contain character metadata');
    let value: unknown;
    try {
        value = JSON.parse(Buffer.from(selected, 'base64').toString('utf8'));
    } catch {
        throw new HttpError(400, 'PNG character metadata is invalid');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new HttpError(400, 'PNG character metadata is invalid');
    }
    return value as Record<string, unknown>;
}

function textChunk(keyword: string, value: string): Uint8Array {
    const type = new TextEncoder().encode('tEXt');
    const keywordBytes = new TextEncoder().encode(keyword);
    const valueBytes = new TextEncoder().encode(value);
    const payload = new Uint8Array(keywordBytes.length + 1 + valueBytes.length);
    payload.set(keywordBytes);
    payload.set(valueBytes, keywordBytes.length + 1);
    const crcInput = new Uint8Array(type.length + payload.length);
    crcInput.set(type);
    crcInput.set(payload, type.length);
    const result = new Uint8Array(12 + payload.length);
    const view = new DataView(result.buffer);
    view.setUint32(0, payload.length, false);
    result.set(type, 4);
    result.set(payload, 8);
    view.setUint32(8 + payload.length, crc32(crcInput.buffer) >>> 0, false);
    return result;
}

export function writePngCharacter(bytes: Uint8Array, card: Record<string, unknown>): Uint8Array {
    const descriptors = chunks(bytes);
    const cardText = JSON.stringify(card);
    const v3Card = { ...card, spec: 'chara_card_v3', spec_version: '3.0' };
    const additions = [
        textChunk('chara', Buffer.from(cardText, 'utf8').toString('base64')),
        textChunk('ccv3', Buffer.from(JSON.stringify(v3Card), 'utf8').toString('base64')),
    ];
    const parts: Uint8Array[] = [bytes.subarray(0, 8)];
    for (const chunk of descriptors) {
        if (chunk.type === 'IEND') parts.push(...additions);
        if (chunk.type === 'tEXt') {
            const keyword = textKeyword(bytes, chunk);
            if (keyword === 'chara' || keyword === 'ccv3') continue;
        }
        parts.push(bytes.subarray(chunk.start, chunk.end));
    }
    const length = parts.reduce((total, part) => total + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}
