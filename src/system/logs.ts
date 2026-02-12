export function fetchLogs(
  guestIp: string,
  port: number,
  agentToken: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { Socket } = require("node:net") as typeof import("node:net");
    const socket = new Socket();
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout"));
    }, 5000);

    socket.connect(port, guestIp, () => {
      socket.write(
        `${JSON.stringify({ type: "get-logs", token: agentToken })}\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString();
    });
    socket.on("end", () => {
      clearTimeout(timer);
      socket.end();
      resolve(response.trim());
    });
    socket.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
