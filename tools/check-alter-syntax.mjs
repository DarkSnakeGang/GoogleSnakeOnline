import fs from "fs";
import path from "path";
import { JSDOM } from "jsdom";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const snake = fs.readFileSync(
  path.join(root, "..", "GoogleSnakeRemix", ".cache", "snake-current.js"),
  "utf8"
);
const mp = fs.readFileSync(path.join(root, "MultiplayerMod.js"), "utf8");

const dom = new JSDOM(
  '<!doctype html><html><body><div class="EjCLSb"></div><div id="count"></div><div id="speed"></div><div id="size"></div><div id="trophy"></div><canvas class="jNB0Ic"></canvas></body></html>',
  { url: "https://snake.google/", runScripts: "outside-only" }
);
const { window } = dom;
window.console = {
  log() {},
  info() {},
  warn(...a) {
    console.warn(...a);
  },
  error(...a) {
    console.error(...a);
  },
  debug() {},
};

// Install on the JSDOM/VM realm String — library alters look up methods there.
function installAssertReplace(Str) {
  Str.prototype.assertReplace = function (regex, replacement) {
    if (typeof regex === "string") {
      if (!this.includes(regex)) {
        throw new Error("assertReplace miss: " + regex.slice(0, 80));
      }
      return this.replace(regex, replacement);
    }
    const copy = new RegExp(
      regex.source,
      regex.flags.replace("g", "") + (regex.flags.includes("g") ? "g" : "")
    );
    if (!copy.test(this)) {
      throw new Error("assertReplace miss re: " + regex);
    }
    copy.lastIndex = 0;
    return this.replace(regex, replacement);
  };
  Str.prototype.assertReplaceAll = function (regex, replacement) {
    return this.replace(regex, replacement);
  };
}
installAssertReplace(String);
installAssertReplace(window.String);
window.assertReplace = function (baseText, regex, replacement) {
  return window.String.prototype.assertReplace.call(baseText, regex, replacement);
};
window.catchError = function () {
  return false;
};
window.diagnoseRegexError = function () {};
window.findFunctionInCode = function (code, functionSignature, somethingInsideFunction, logging = false) {
  let functionSignatureSource = functionSignature.source;
  let functionSignatureFlags = functionSignature.flags || "";
  if (!functionSignatureFlags.includes("g")) functionSignatureFlags += "g";
  functionSignatureSource = functionSignatureSource.replaceAll(/\$(?=\|)|\$$/g, "");
  functionSignatureSource = functionSignatureSource.replaceAll(/,|=/g, "$&\\n?");
  functionSignature = new RegExp(functionSignatureSource, functionSignatureFlags);
  const indexWithinFunction = code.search(somethingInsideFunction);
  if (indexWithinFunction === -1) {
    throw new Error("Couldn't find a match for somethingInsideFunction");
  }
  const codeBeforeMatch = code.substring(0, indexWithinFunction);
  const signatureMatches = [...codeBeforeMatch.matchAll(functionSignature)];
  if (signatureMatches.length === 0) {
    throw new Error("Couldn't find function signature");
  }
  const startIndex = signatureMatches[signatureMatches.length - 1].index;
  let bracketCount = 0;
  let foundFirstBracket = false;
  let endIndex = 0;
  for (let i = startIndex; i <= code.length; i++) {
    if (!foundFirstBracket && code[i] === "{") foundFirstBracket = true;
    if (code[i] === "{") bracketCount++;
    if (code[i] === "}") bracketCount--;
    if (foundFirstBracket && bracketCount === 0) {
      endIndex = i;
      break;
    }
    if (i === code.length) throw new Error("Couldn't pair up brackets");
  }
  const fullFunction = code.substring(startIndex, endIndex + 1);
  if (fullFunction.search(somethingInsideFunction) === -1) {
    throw new Error("Function signature does not belong to the same function as somethingInsideFunction");
  }
  if (logging) console.log(fullFunction);
  return fullFunction;
};

vm.runInContext(mp, dom.getInternalVMContext(), {
  filename: "MultiplayerMod.js",
  timeout: 120000,
});

const Mod = window.MultiplayerMod || window.RemixMod;

// Stub missing library make/alter so alter can proceed even if CDN libs missing
const libNames = window.Libraries || [
  "Core",
  "Theme",
  "DistinctVisual",
  "Counter",
  "ModeRegistry",
  "TimeKeeper",
  "Fruit",
  "GraphicsMix",
  "TopBar",
  "SnakeColor",
  "SettingsSaver",
  "SpeedInfo",
  "InputDisplay",
  "Timer",
  "SplitPanel",
  "Backup",
  "BootstrapMenu",
  "ResetKey",
  "RenderDelayFix",
  "CustomBowl",
];
window.Libraries = libNames;
for (const name of libNames) {
  if (!window[name]) {
    window[name] = {
      make() {},
      alterCode(c) {
        return c;
      },
    };
  } else if (!window[name].alterCode) {
    window[name].alterCode = function (c) {
      return c;
    };
  }
}

if (typeof Mod.runCodeBefore === "function") {
  try {
    Mod.runCodeBefore();
  } catch (e) {
    console.warn("runCodeBefore:", e.message);
  }
}

// Re-install after runCodeBefore (Hamilton may redefine; Core.make may fail in jsdom)
installAssertReplace(String);
installAssertReplace(window.String);
window.assertReplace = function (baseText, regex, replacement) {
  return window.String.prototype.assertReplace.call(baseText, regex, replacement);
};
if (typeof window.findFunctionInCode !== "function") {
  // keep the one installed above
}

// Re-ensure Libraries after runCodeBefore may have reset them
if (!window.Libraries) window.Libraries = libNames;
for (const name of window.Libraries) {
  if (!window[name]) {
    window[name] = {
      make() {},
      alterCode(c) {
        return c;
      },
    };
  } else if (typeof window[name].alterCode !== "function") {
    window[name].alterCode = function (c) {
      return c;
    };
  } else {
    // Soften library alters that throw on missing patterns
    const orig = window[name].alterCode.bind(window[name]);
    window[name].alterCode = function (c) {
      try {
        return orig(c);
      } catch (e) {
        console.warn(name + ".alterCode:", e.message);
        return c;
      }
    };
  }
}

// Soften every *Mod/*.alterSnakeCode so a DOM-less harness still reaches LAN/Remix patches
for (const key of Object.getOwnPropertyNames(window)) {
  const obj = window[key];
  if (!obj || typeof obj !== "object") continue;
  if (typeof obj.alterSnakeCode !== "function") continue;
  if (obj.__softAlterWrapped) continue;
  const orig = obj.alterSnakeCode.bind(obj);
  obj.alterSnakeCode = function (c) {
    try {
      return orig(c);
    } catch (e) {
      console.warn(key + ".alterSnakeCode:", e.message);
      return c;
    }
  };
  obj.__softAlterWrapped = true;
}
// Also wrap standalone alter helpers used by RemixMod
for (const name of ["VisibilityModCode", "moreMenu"]) {
  if (window[name] && typeof window[name].alterSnakeCode === "function" && !window[name].__softAlterWrapped) {
    const orig = window[name].alterSnakeCode.bind(window[name]);
    window[name].alterSnakeCode = function (c) {
      try {
        return orig(c);
      } catch (e) {
        console.warn(name + ".alterSnakeCode:", e.message);
        return c;
      }
    };
    window[name].__softAlterWrapped = true;
  }
}

let out;
try {
  out = Mod.alterSnakeCode(snake);
} catch (e) {
  console.error("ALTER", e.message);
  console.error(e.stack.split("\n").slice(0, 15).join("\n"));
  process.exit(1);
}

const cacheDir = path.join(root, ".cache");
fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(path.join(cacheDir, "altered-snake.js"), out);
const lines = out.split("\n");
console.log("altered lines", lines.length, "chars", out.length);

try {
  new Function(out);
  console.log("PARSE OK");
} catch (e) {
  console.log("PARSE FAIL:", e.message);
  try {
    new vm.Script(out, { filename: "altered-snake.js" });
  } catch (e2) {
    console.log("vm.Script:", e2.message);
    const m = /altered-snake\.js:(\d+)(?::(\d+))?/.exec(e2.stack || e2.message || "");
    if (m) {
      const bad = Number(m[1]);
      console.log("first failing at line", bad, "col", m[2] || "?");
      for (let i = Math.max(0, bad - 5); i < Math.min(lines.length, bad + 5); i++) {
        console.log(
          String(i + 1).padStart(5) + (i + 1 === bad ? ">>>" : ":  ") + lines[i].slice(0, 300)
        );
      }
    } else {
      console.log((e2.stack || "").split("\n").slice(0, 8).join("\n"));
    }
  }
}
