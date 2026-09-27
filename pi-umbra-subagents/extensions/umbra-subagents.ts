// The live agent view: a widget above the input box, a full-screen panel, and the fan producer
// that feeds them. Everything is under ./umbra-subagents/; this file exists because pi scans
// extensions/*.ts and the entry point is nested.
export { default } from "./umbra-subagents/fan/index.ts";
