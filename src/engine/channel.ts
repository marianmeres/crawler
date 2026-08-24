/**
 * Internal — the bounded hand-off between the crawl workers and the `run()` iterator.
 *
 * This tiny class is the entire backpressure story on the consumer side: a worker's
 * {@linkcode Channel.push} *parks* once the buffer is full, so a slow `for await` body
 * stops the workers instead of letting completed pages pile up in memory. (The other
 * half is the global in-flight cap, which stops the dispatcher.)
 *
 * It is deliberately not a general-purpose queue: exactly one consumer (`run()`) calls
 * {@linkcode Channel.next}, many producers call {@linkcode Channel.push}, and the
 * lifecycle is one-way — once closed, a channel never reopens.
 *
 * @module
 */

interface ParkedProducer<T> {
	value: T;
	resolve: () => void;
}

interface ParkedConsumer<T> {
	resolve: (result: IteratorResult<T>) => void;
	reject: (error: unknown) => void;
}

/**
 * A fixed-capacity async queue with parking on both ends.
 *
 * Ordering is strict FIFO across both the buffer and the parked producers, so results
 * reach the consumer in completion order even when the channel spent time full.
 */
export class Channel<T> {
	#capacity: number;
	readonly #buffer: T[] = [];
	readonly #producers: ParkedProducer<T>[] = [];
	readonly #consumers: ParkedConsumer<T>[] = [];
	#closed = false;
	#failure: { error: unknown } | undefined;

	/**
	 * @param capacity Buffered values before {@linkcode Channel.push} starts parking.
	 * Values below `1` are raised to `1` — a zero-capacity channel would park every
	 * producer even with an idle consumer.
	 */
	constructor(capacity: number) {
		this.#capacity = Number.isFinite(capacity)
			? Math.max(1, Math.floor(capacity))
			: 1;
	}

	/** Buffered values not yet taken. Diagnostics only. */
	get size(): number {
		return this.#buffer.length;
	}

	/** Has {@linkcode Channel.close} or {@linkcode Channel.fail} been called? */
	get closed(): boolean {
		return this.#closed;
	}

	/**
	 * Offer a value.
	 *
	 * Resolves as soon as the value has been accepted — handed to a waiting consumer,
	 * or buffered. When the buffer is full the promise stays pending until the consumer
	 * drains one, which is what makes a slow consumer slow the crawl.
	 *
	 * Pushing to a **closed** channel resolves immediately and *discards* the value:
	 * that is the `stop()` / consumer-`break` path, where in-flight pages still have to
	 * finish and record themselves but their results are no longer delivered.
	 */
	push(value: T): Promise<void> {
		if (this.#closed) return Promise.resolve();

		const consumer = this.#consumers.shift();
		if (consumer !== undefined) {
			consumer.resolve({ value, done: false });
			return Promise.resolve();
		}

		if (this.#buffer.length < this.#capacity) {
			this.#buffer.push(value);
			return Promise.resolve();
		}

		return new Promise<void>((resolve) => {
			this.#producers.push({ value, resolve });
		});
	}

	/**
	 * Take the next value.
	 *
	 * A closed channel still drains whatever it buffered before reporting
	 * `{ done: true }`; a failed one rejects once, with the error
	 * {@linkcode Channel.fail} was given.
	 */
	next(): Promise<IteratorResult<T>> {
		if (this.#buffer.length > 0) {
			const value = this.#buffer.shift() as T;
			this.#pump();
			return Promise.resolve({ value, done: false });
		}

		if (this.#failure !== undefined) {
			const { error } = this.#failure;
			this.#failure = undefined;
			return Promise.reject(error);
		}

		if (this.#closed) {
			return Promise.resolve({ value: undefined, done: true });
		}

		return new Promise<IteratorResult<T>>((resolve, reject) => {
			this.#consumers.push({ resolve, reject });
		});
	}

	/**
	 * Drop the capacity bound: from here on {@linkcode Channel.push} buffers instead of
	 * parking. Idempotent, and there is no way back.
	 *
	 * This exists for the graceful-stop path. `stop()` has to *deliver* the pages that
	 * are already in flight, which means it cannot close the channel until they finish
	 * — but a worker parked on `push()` only finishes when the consumer takes a value,
	 * and a consumer that wrote `await crawler.stop()` inside its own `for await` body
	 * is not going to. Relaxing first breaks that cycle; the extra memory is bounded by
	 * the in-flight count, i.e. `concurrency` results.
	 */
	relax(): void {
		this.#capacity = Infinity;
		this.#pump();
	}

	/**
	 * End the stream. Idempotent.
	 *
	 * Parked producers are released (their values dropped — there is no longer anyone
	 * to deliver them to) and a parked consumer is answered `{ done: true }`. Buffered
	 * values survive: they are still handed out by the remaining {@linkcode next} calls.
	 */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#releaseProducers();
		for (const consumer of this.#consumers.splice(0)) {
			consumer.resolve({ value: undefined, done: true });
		}
	}

	/**
	 * End the stream with an error: the parked consumer — or the next
	 * {@linkcode next} call — rejects with it. Buffered values are dropped, because an
	 * error means the run did not produce what it was going to produce.
	 */
	fail(error: unknown): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#buffer.length = 0;
		this.#releaseProducers();

		const consumer = this.#consumers.shift();
		for (const rest of this.#consumers.splice(0)) {
			rest.resolve({ value: undefined, done: true });
		}
		if (consumer !== undefined) consumer.reject(error);
		else this.#failure = { error };
	}

	/** Move parked producers' values into the freed buffer slots, in arrival order. */
	#pump(): void {
		while (this.#buffer.length < this.#capacity && this.#producers.length > 0) {
			const producer = this.#producers.shift() as ParkedProducer<T>;
			this.#buffer.push(producer.value);
			producer.resolve();
		}
	}

	#releaseProducers(): void {
		for (const producer of this.#producers.splice(0)) producer.resolve();
	}
}
