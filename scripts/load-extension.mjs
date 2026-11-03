// Loads an unpacked extension into a running Chrome over CDP
// (Extensions.loadUnpacked, which needs --enable-unsafe-extension-debugging).
// Usable as a module (scripts/dev-browser.mjs) or directly:
//   node scripts/load-extension.mjs <browser-websocket-url> <extension-path>
import { pathToFileURL } from "node:url";

export function loadUnpackedExtension(webSocketUrl, extensionPath, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out while loading the extension."));
    }, timeoutMs);

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Extensions.loadUnpacked",
          params: { path: extensionPath }
        })
      );
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) {
        reject(new Error(`Chrome rejected the unpacked extension: ${JSON.stringify(message.error)}`));
      } else {
        resolve(message.result);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Unable to connect to the Chrome DevTools browser endpoint."));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [webSocketUrl, extensionPath] = process.argv.slice(2);
  if (!webSocketUrl || !extensionPath) {
    console.error("Usage: node load-extension.mjs <browser-websocket-url> <extension-path>");
    process.exit(2);
  }
  loadUnpackedExtension(webSocketUrl, extensionPath).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
}
