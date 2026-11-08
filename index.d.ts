import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ProfileInput } from "./profile.js";
export interface JoinRequest {
    url: string;
    name?: string;
    /** Profile path or bundled profile name; defaults to $MAYFLY_PROFILE. */
    profile?: string;
    /** Explicit overrides (highest precedence). */
    overrides?: ProfileInput;
    /** One line on what this agent is working on (posted in the join intro). */
    task?: string;
}
export default function mayflyExtension(pi: ExtensionAPI): void;
