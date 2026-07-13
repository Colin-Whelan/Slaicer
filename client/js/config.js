// Runtime mode.
//   IS_LOCAL = true  -> desktop/local: use File System Access pickers (real Save/Open
//                       dialogs that write straight to disk), plus folder export.
//   IS_LOCAL = false -> hosted/server: no direct disk access; Save = browser download,
//                       Export = zip download.
//
// Auto-detected from where the page is served. Anything served over a real host
// (e.g. slaicer.aericode.deno.net) is hosted; only localhost / loopback / file://
// count as local. This keeps Chrome on the hosted site from writing raw folders to
// disk via showDirectoryPicker — it uses the normal zip download like Firefox does.
function detectLocal() {
  if (typeof window === "undefined") return false;
  const { protocol, hostname } = window.location;
  if (protocol === "file:") return true;
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".localhost")
  );
}

export const IS_LOCAL = detectLocal();
