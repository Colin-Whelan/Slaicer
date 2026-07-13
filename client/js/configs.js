// Email-template configs: browser-saved, multiple variants (default, French, VIP…),
// import/export JSON for recovery/sharing. Each config is a set of handlebar templates.

const KEY = "slaicer.configs";

// The shell + cell markup are hardcoded in html-gen.js. A config only supplies the
// per-company/per-variant variables.
function seedDefault() {
  return {
    name: "Default",
    companyName: "",
    width: 600,
    baseUrl: "",
    autoAppendParams: "",
    header: "",
    footer: "",
  };
}

export function defaultConfigs() {
  return [seedDefault()];
}

export function loadConfigs() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || "null");
    if (Array.isArray(c) && c.length) return c;
  } catch {}
  const seed = defaultConfigs();
  saveConfigs(seed);
  return seed;
}

export function saveConfigs(configs) {
  localStorage.setItem(KEY, JSON.stringify(configs));
}

export function exportConfigs() {
  return JSON.stringify(loadConfigs(), null, 2);
}

export function importConfigs(text) {
  const parsed = JSON.parse(text);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  if (!arr.length || !arr.every((c) => c && typeof c.name === "string")) {
    throw new Error("Not a valid configs file");
  }
  saveConfigs(arr);
  return arr;
}

export function blankConfig(name) {
  return { name: name || "New config", companyName: "", width: 600, baseUrl: "", autoAppendParams: "", header: "", footer: "" };
}
