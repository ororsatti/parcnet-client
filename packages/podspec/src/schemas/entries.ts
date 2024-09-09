import { PODValue } from "@pcd/pod";
import { EntrySchema } from "./entry.js";

/**
 * Schema for validating a PODEntries object.
 */
export type EntriesSchema = Record<string, EntrySchema>;

/**
 * Schema for a tuple of entries.
 */
export type EntriesTupleSchema<E extends EntriesSchema> = {
  entries: (keyof E)[];
  isMemberOf?: PODValue[][];
  isNotMemberOf?: PODValue[][];
};
