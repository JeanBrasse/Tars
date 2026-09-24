import type { ClientRequest, IncomingMessage, RequestOptions } from "http";

/**
 * One request over http or https, its answer read whole as text. Reaching the
 * host and reading what it answered is the same for every client here; what
 * each makes of the answer, and how it words a host it could not reach, stays
 * its own. A timeout in the options ends the request with "no answer within
 * N s".
 */
export function send(
  via: { request(options: RequestOptions, onAnswer: (res: IncomingMessage) => void): ClientRequest },
  options: RequestOptions,
  body: string | undefined,
  unreachable: (error: Error) => Error,
): Promise<{ status: number | undefined; data: string }> {
  return new Promise((resolve, reject) => {
    const req = via.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", (err) => reject(unreachable(err)));
    const timeout = options.timeout;
    if (timeout) req.on("timeout", () => req.destroy(new Error(`no answer within ${timeout / 1000} s`)));
    if (body) req.write(body);
    req.end();
  });
}
