import { HttpError, json, maxJsonBytes, readJson, requireString } from '../http';
import type { Router } from '../router';

const LABELS = [
    'admiration', 'amusement', 'anger', 'annoyance', 'approval', 'caring', 'confusion', 'curiosity',
    'desire', 'disappointment', 'disapproval', 'disgust', 'embarrassment', 'excitement', 'fear',
    'gratitude', 'grief', 'joy', 'love', 'nervousness', 'optimism', 'pride', 'realization', 'relief',
    'remorse', 'sadness', 'surprise', 'neutral',
] as const;

const CLUES: ReadonlyArray<readonly [label: string, expression: RegExp]> = [
    ['anger', /\b(?:angry|furious|rage|hate)\b|生气|愤怒|恨/iu],
    ['sadness', /\b(?:sad|unhappy|depressed|cry|tears)\b|难过|悲伤|哭/iu],
    ['joy', /\b(?:happy|glad|delighted|wonderful|yay)\b|开心|高兴|快乐/iu],
    ['love', /\b(?:love|adore|darling|sweetheart)\b|爱你|喜欢/iu],
    ['fear', /\b(?:afraid|scared|terrified|fear)\b|害怕|恐惧/iu],
    ['surprise', /\b(?:surprised|amazing|unexpected|wow)\b|惊讶|意外|哇/iu],
    ['confusion', /\b(?:confused|unclear|what do you mean)\b|困惑|不明白|什么意思/iu],
    ['curiosity', /\b(?:curious|wonder|how|why)\b|好奇|为什么|怎么/iu],
    ['gratitude', /\b(?:thanks|thank you|grateful)\b|谢谢|感谢/iu],
    ['excitement', /\b(?:excited|thrilled|can\x27t wait)\b|兴奋|期待/iu],
    ['amusement', /(?:\b(?:funny|hilarious|laugh)\b|哈哈|笑死|lol)/iu],
    ['approval', /\b(?:agree|approved|exactly|yes)\b|同意|赞成|没错/iu],
    ['disapproval', /\b(?:disagree|wrong|no way)\b|反对|不同意|不行/iu],
    ['remorse', /\b(?:sorry|apologize|regret)\b|对不起|抱歉|后悔/iu],
    ['nervousness', /\b(?:nervous|anxious|worried)\b|紧张|焦虑|担心/iu],
    ['optimism', /\b(?:hope|optimistic|will be fine)\b|希望|会好的/iu],
];

function classify(source: string): Array<{ label: string; score: number }> {
    const found = CLUES.filter(([, expression]) => expression.test(source)).map(([label]) => label);
    const primary = found[0] ?? 'neutral';
    const secondary = found.slice(1, 5);
    return [
        { label: primary, score: found.length > 0 ? 0.88 : 0.72 },
        ...secondary.map((label, index) => ({ label, score: Math.max(0.08, 0.45 - index * 0.09) })),
    ];
}

export function registerClassificationRoutes(router: Router): void {
    const labels = () => json({ labels: LABELS });
    const classification = async ({ request, env }: { request: Request; env: Env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const source = requireString(body.text, 'text', 20_000);
        return json({ classification: classify(source) });
    };
    router.on('POST', '/api/classify/labels', labels);
    router.on('POST', '/api/extra/classify/labels', labels);
    router.on('POST', '/api/classify', classification);
    router.on('POST', '/api/extra/classify', classification);
    router.on('POST', '/api/caption', () => {
        throw new HttpError(422, 'Local image captioning is not available in the free-CPU profile; select an API caption provider');
    });
    router.on('POST', '/api/extra/caption', () => {
        throw new HttpError(422, 'Local image captioning is not available in the free-CPU profile; select an API caption provider');
    });
}
