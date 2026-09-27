// One settings key for every umbra extension, read from pi's own settings file.
//
// This lives outside extensions/ because pi loads every .ts in that folder as an extension, and
// keeping the reader free of pi imports is what lets a check exercise it without resolving pi's
// packages.
import { readFileSync } from "node:fs";

export type UmbraSettings = {
    /** "auto" follows the active theme, "off" leaves the terminal alone, "#rrggbb" is literal. */
    background?: string;
    messages?: {
        /** Draw model text as a quote block, so it reads apart from your own lines. */
        assistantPrefix?: boolean;
    };
    tools?: {
        /** "boxed" frames every tool call; anything else leaves pi's own rows alone. */
        chrome?: string;
    };
    working?: {
        /**
         * One entry per pi tool name, plus `thinking`, `idle` and `custom` for the three states
         * that are not tools. Fields merge over the defaults one by one, so naming only `label`
         * keeps the animation. A `frames` array replaces rather than merges.
         */
        tools?: Record<string, { label?: string; cycleMs?: number; frames?: string[] }>;
        /** Show "↓ 180 tokens". */
        tokens?: boolean;
        /** Show "(5s)". */
        elapsed?: boolean;
    };
};

const SETTINGS_KEY = "piUmbraTheme";

const agentDirectory = (): string =>
    process.env.PI_CODING_AGENT_DIR ?? `${process.env.USERPROFILE ?? process.env.HOME}/.pi/agent`;

/**
 * Never throws: a missing or half-written settings file means "no preferences expressed", which
 * is the same answer as an empty block, and a theme extension is no place to fail a session over.
 */
export const readUmbraSettings = (): UmbraSettings => {
    try {
        const raw = readFileSync(`${agentDirectory()}/settings.json`, "utf8");
        // SAFETY: every branch below re-checks the field it reads, so a settings file of any
        // shape yields defaults rather than a wrong type reaching a caller.
        const parsed = JSON.parse(raw) as Record<string, UmbraSettings | undefined>;
        return parsed[SETTINGS_KEY] ?? {};
    } catch {
        return {};
    }
};
