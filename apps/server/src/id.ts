/**
 * Prefixed public IDs (spec §6). Every public ID carries a type prefix so logs,
 * URLs and external references are self-describing. Database security never
 * relies on ID guessability — workspace membership is always checked.
 */
import { customAlphabet } from 'nanoid';

// url-safe, unambiguous alphabet (no l, 1, I, O, 0). 21 chars ≈ 122 bits.
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const newId = customAlphabet(alphabet, 21);

const prefix =
  <P extends string>(p: P) =>
  (): `${P}_${string}` =>
    `${p}_${newId()}`;

export const newUserId = prefix('usr');
export const newWorkspaceId = prefix('ws');
export const newProjectId = prefix('prj');
export const newOperationId = prefix('op');
export const newEventId = prefix('evt');
export const newPersonalAccessTokenId = prefix('pat');
/**
 * Unprefixed task id (spec §6: "UUID v4 or nanoid"). MCP create_task mints the
 * id up front so the same value is known for dependency wiring and the
 * external-reference record.
 */
export const newTaskId = (): string => newId();
