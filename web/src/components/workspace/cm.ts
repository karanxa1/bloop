/**
 * CodeMirror 6 setup — only ever reached through a dynamic import, so the
 * editor core lands in its own chunk and each language in another.
 */
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

const js = (o: { typescript?: boolean; jsx?: boolean } = {}) => () =>
  import("@codemirror/lang-javascript").then((m) => m.javascript(o));

const LANGS: Record<string, () => Promise<Extension>> = {
  ts: js({ typescript: true }),
  mts: js({ typescript: true }),
  tsx: js({ typescript: true, jsx: true }),
  js: js(),
  mjs: js(),
  cjs: js(),
  jsx: js({ jsx: true }),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  htm: () => import("@codemirror/lang-html").then((m) => m.html()),
  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  rs: () => import("@codemirror/lang-rust").then((m) => m.rust())
};

const langFor = (path: string) => {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? LANGS[m[1].toLowerCase()] : undefined;
};

// light brand theme — all token colors ≥4.5:1 on white
const bloopHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "#4a7322", fontWeight: "600" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#a0480a" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6b6b6b", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#0e7490" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#1d4ed8" },
  { tag: [t.typeName, t.className, t.namespace], color: "#0f766e" },
  { tag: [t.definition(t.variableName)], color: "#262626" },
  { tag: [t.propertyName, t.attributeName], color: "#7c3aed" },
  { tag: [t.tagName, t.angleBracket], color: "#4a7322" },
  { tag: [t.heading], color: "#171717", fontWeight: "700" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.link, t.url], color: "#1d4ed8", textDecoration: "underline" },
  { tag: [t.meta, t.processingInstruction], color: "#6b6b6b" },
  { tag: [t.invalid], color: "#b91c1c" }
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", fontSize: "12.5px", backgroundColor: "#ffffff", color: "#262626" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      lineHeight: "1.6"
    },
    ".cm-content": { caretColor: "#5c8a2c", padding: "6px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#5c8a2c", borderLeftWidth: "2px" },
    ".cm-gutters": { backgroundColor: "#fafafa", color: "#8a8a8a", borderRight: "1px solid #e5e5e5" },
    ".cm-activeLine": { backgroundColor: "rgba(141, 198, 63, 0.07)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(141, 198, 63, 0.16)", color: "#3f6b1a" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "rgba(141, 198, 63, 0.3)" },
    "&.cm-focused .cm-matchingBracket": { backgroundColor: "rgba(141, 198, 63, 0.35)", outline: "1px solid #8dc63f" },
    "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "rgba(239, 68, 68, 0.2)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(141, 198, 63, 0.18)" },
    ".cm-searchMatch": { backgroundColor: "rgba(250, 204, 21, 0.35)", outline: "1px solid rgba(202, 138, 4, 0.5)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(141, 198, 63, 0.5)" },
    ".cm-panels": { backgroundColor: "#fafafa", color: "#262626" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid #e5e5e5", borderLeft: "2px solid #8dc63f" },
    ".cm-panel.cm-search": { padding: "6px 8px", fontSize: "12px" },
    ".cm-panel.cm-search label": { fontSize: "12px" },
    ".cm-textfield": {
      border: "1px solid #d4d4d4",
      borderRadius: "0",
      backgroundColor: "#fff",
      padding: "2px 6px",
      fontSize: "12px"
    },
    ".cm-textfield:focus-visible": { outline: "2px solid #5c8a2c", outlineOffset: "0" },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: "#fff",
      border: "1px solid #d4d4d4",
      borderRadius: "9999px",
      padding: "1px 10px",
      fontSize: "12px"
    },
    ".cm-button:focus-visible": { outline: "2px solid #5c8a2c" },
    '.cm-panel.cm-search [name="close"]': { fontSize: "18px", color: "#525252" }
  },
  { dark: false }
);

export interface EditorCallbacks {
  onChange: (path: string, doc: string) => void;
  onSave: (path: string) => void;
}

export interface EditorHandle {
  /** show `path` with `doc`; idempotent — call on every render */
  open: (path: string, doc: string, readOnly: boolean) => void;
  /** forget cached states for paths no longer open */
  retain: (paths: readonly string[]) => void;
  focus: () => void;
  destroy: () => void;
}

export function mountEditor(parent: HTMLElement, cb: EditorCallbacks): EditorHandle {
  const roC = new Compartment();
  const langC = new Compartment();
  const states = new Map<string, EditorState>();
  const known = new Map<string, string>(); // last doc text we saw per path
  const locked = new Map<string, boolean>();
  let current = "";

  const roExt = (path: string, readOnly: boolean): Extension => [
    EditorState.readOnly.of(readOnly),
    EditorView.contentAttributes.of({
      "aria-label": readOnly ? `${path} (read-only while bloop is writing)` : `edit ${path}`
    })
  ];

  const base = (path: string, readOnly: boolean): Extension[] => [
    Prec.high(
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            cb.onSave(current);
            return true;
          }
        }
      ])
    ),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    syntaxHighlighting(bloopHighlight, { fallback: true }),
    theme,
    EditorView.lineWrapping,
    keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
    roC.of(roExt(path, readOnly)),
    langC.of([]),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      const doc = u.state.doc.toString();
      known.set(current, doc);
      cb.onChange(current, doc);
    })
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc: "", extensions: base("", true) }) });

  const loadLanguage = (path: string) => {
    const load = langFor(path);
    if (!load) return;
    load()
      .then((ext) => {
        const effects = langC.reconfigure(ext);
        if (current === path) view.dispatch({ effects });
        else {
          const s = states.get(path);
          if (s) states.set(path, s.update({ effects }).state);
        }
      })
      .catch(() => {
        /* plain text fallback */
      });
  };

  return {
    open(path, doc, readOnly) {
      if (path !== current) {
        if (current) states.set(current, view.state);
        current = path;
        const cached = states.get(path);
        if (cached) view.setState(cached);
        else {
          view.setState(EditorState.create({ doc, extensions: base(path, readOnly) }));
          known.set(path, doc);
          locked.set(path, readOnly);
          loadLanguage(path);
        }
      }
      if (known.get(path) !== doc && view.state.doc.toString() !== doc) {
        known.set(path, doc);
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
      }
      known.set(path, doc);
      if (locked.get(path) !== readOnly) {
        locked.set(path, readOnly);
        view.dispatch({ effects: roC.reconfigure(roExt(path, readOnly)) });
      }
    },
    retain(paths) {
      for (const key of [...states.keys()]) {
        if (!paths.includes(key)) {
          states.delete(key);
          known.delete(key);
          locked.delete(key);
        }
      }
    },
    focus: () => view.focus(),
    destroy: () => view.destroy()
  };
}
