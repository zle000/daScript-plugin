async function wait(ms: number) : Promise<void> {
    return new Promise<void>(resolve => {
        setTimeout(() => resolve(), ms);
    });
}


export class ValidatingQueue {
    private workers = new Map<string, Promise<void>>;

    public get size(): number {
        return this.workers.size;
    }
    
    constructor(public readonly capacity: number = 10) { }

    public async enqueue(key: string, cb : () => Promise<void>) {
        while (this.workers.size >= this.capacity) {
            console.log(`[queue] Queue is overcrowded, waiting...`)
            await wait(500);
        }
        
        let worker = cb();
        console.log(`[queue] Added to queue, ${key}. Queue size: ${this.workers.size}`)

        this.workers.set(key, worker);
        worker.then(() => {
            this.workers.delete(key);
            console.log(`[queue] Worker done. Queue size: ${this.workers.size}`);
        });
    }

    public async waitAll() {
        return await Promise.all(this.workers.values());
    }
}