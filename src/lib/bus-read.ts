/** How long a read of the bus is given before the page says it did not answer. */
export const BUS_READ_MS = 10_000;

/**
 * The waits before each new read of what the bus failed to give: three more
 * tries, each wait longer than the last, the last try 30 s after the first
 * failure. Then the note stays until a message or a click reads again.
 */
export const BUS_RETRY_MS: readonly number[] = [3_000, 9_000, 18_000];

/** What the page says when the bus has not answered in time. */
export const noAnswer = (channel: string) => new Error(`${channel}, no answer in ${BUS_READ_MS / 1000} s`);

export interface RetryingRead {
  /** Reads now, or once the read that is out comes back. A new start: the
   *  tries count again from none, and a try that was pending is dropped. */
  read(): void;
  /** For good: nothing more is sent, and nothing that comes back is shown. */
  stop(): void;
}

/**
 * A read of the bus that neither gives up on a slow answer nor on a failed one.
 *
 * The Chat's room list was read once and given 10 s. On a slow start the read
 * ran out, the page said the bus did not answer, and the answer that came at
 * 12 s was thrown away: an empty Chat until a message landed or you clicked
 * retry. Now the 10 s are when the page says so, not when it stops listening:
 * a late answer is shown when it comes. A read that fails, refused or
 * answered with an error, is sent again after each of BUS_RETRY_MS. One read
 * is out at a time: the main process answers in the order it is asked, so a
 * second read behind a slow one would only come back after it.
 */
export function retryingRead<T>({ channel, call, failure, onAnswer, onFailure }: {
  channel: string;
  call: () => Promise<T>;
  /** What an answer says went wrong, when it says so. */
  failure?: (answer: T) => string | null | undefined;
  onAnswer: (answer: T) => void;
  onFailure: (error: unknown) => void;
}): RetryingRead {
  let stopped = false;
  let out = false;
  /** A read was asked for while one was out. */
  let again = false;
  let tries = 0;
  /** The read's 10 s while it is out, or the wait before the next try. */
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const back = (failed: boolean) => {
    out = false;
    clear();
    if (again) {
      again = false;
      tries = 0;
      send();
    } else if (failed && tries < BUS_RETRY_MS.length) {
      timer = setTimeout(() => { timer = undefined; send(); }, BUS_RETRY_MS[tries++]);
    }
  };

  function send() {
    clear();
    out = true;
    timer = setTimeout(() => { timer = undefined; onFailure(noAnswer(channel)); }, BUS_READ_MS);
    let answer: Promise<T>;
    try { answer = call(); } catch (err) { answer = Promise.reject(err); }
    answer.then(
      a => { if (stopped) return; onAnswer(a); back(!!failure?.(a)); },
      err => { if (stopped) return; onFailure(err); back(true); },
    );
  }

  return {
    read() {
      if (stopped) return;
      if (out) { again = true; return; }
      tries = 0;
      send();
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}
