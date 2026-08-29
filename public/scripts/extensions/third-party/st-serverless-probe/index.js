export function activate() {
    console.info('st-serverless-probe activated');
}

export async function interceptGeneration(chat, _contextSize, _abort, _type) {
    void chat;
}
