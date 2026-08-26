import { HttpError, json } from '../http';
import type { Router } from '../router';

const LABELS = [
    'admiration', 'amusement', 'anger', 'annoyance', 'approval', 'caring', 'confusion', 'curiosity',
    'desire', 'disappointment', 'disapproval', 'disgust', 'embarrassment', 'excitement', 'fear',
    'gratitude', 'grief', 'joy', 'love', 'nervousness', 'optimism', 'pride', 'realization', 'relief',
    'remorse', 'sadness', 'surprise', 'neutral',
] as const;

export function registerClassificationRoutes(router: Router): void {
    const labels = () => json({ labels: LABELS });
    const externalOnly = () => {
        throw new HttpError(422, 'Worker-side classification is disabled; select the configured main model or a declared external classification API');
    };
    router.on('POST', '/api/classify/labels', labels);
    router.on('POST', '/api/extra/classify/labels', labels);
    router.on('POST', '/api/classify', externalOnly);
    router.on('POST', '/api/extra/classify', externalOnly);
    router.on('POST', '/api/caption', () => {
        throw new HttpError(422, 'Local image captioning is not available in the free-CPU profile; select an API caption provider');
    });
    router.on('POST', '/api/extra/caption', () => {
        throw new HttpError(422, 'Local image captioning is not available in the free-CPU profile; select an API caption provider');
    });
}
