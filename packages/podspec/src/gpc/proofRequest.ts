import type {
  GPCProofConfig,
  GPCProofEntryConfig,
  GPCProofObjectConfig,
  GPCProofTupleConfig,
  PODEntryIdentifier,
  PODMembershipLists
} from "@pcd/gpc";
import { POD, PODName, PODValue } from "@pcd/pod";
import { PodSpec } from "../parse/pod.js";
import { EntriesSchema } from "../schemas/entries.js";
import { PODSchema } from "../schemas/pod.js";

/**
 * A ProofRequest contains the data necessary to verify that a given GPC proof
 * matches our expectations of it.
 */
export type ProofRequest = {
  proofConfig: GPCProofConfig;
  membershipLists: PODMembershipLists;
  externalNullifier?: PODValue;
  watermark?: PODValue;
};

/**
 * A PodspecProofRequest allows us to generate a {@link ProofRequest} from a
 * set of Podspecs defining the allowable PODs.
 */
export interface PodspecProofRequest {
  pods: Record<string, PODSchema<EntriesSchema>>;
  externalNullifier?: PODValue;
  watermark?: PODValue;
}

/**
 * A ProofRequestSpec allows us to generate a {@link ProofRequest} from a
 * set of Podspecs defining the allowable PODs.
 */
export class ProofRequestSpec<P extends PodspecProofRequest> {
  /**
   * Private constructor, see {@link create}.
   * @param schema The schema of the PODs that are allowed in this proof.
   */
  private constructor(public readonly schema: P) {}

  /**
   * Create a new ProofRequestSpec.
   * @param schema The schema of the PODs that are allowed in this proof.
   * @returns A new ProofRequestSpec.
   */
  public static create<P extends PodspecProofRequest>(
    schema: P
  ): ProofRequestSpec<P> {
    return new ProofRequestSpec(schema);
  }

  /**
   * Get the {@link ProofRequest} that this ProofRequestSpec defines.
   * @returns A {@link ProofRequest}.
   */
  public getProofRequest(): ProofRequest {
    return makeProofRequest(this.schema);
  }

  /**
   * A ProofRequest defines a {@link GPCProofConfig} and part of the
   * {@link GPCProofInputs} - specifically the watermark, external nullifier,
   * and membership lists. However, a GPC proof also requires PODs as inputs.
   * Since we know from our schema which PODs would be acceptable inputs, we
   * can take an array of PODs and return a mapping of the require POD names
   * to the PODs from the array which would be suitable as inputs in each slot
   * respectively.
   *
   * @param pods The PODs to query.
   * @returns A record of the PODs that are allowed in this proof.
   */
  public queryForInputs(pods: POD[]): Record<keyof P["pods"], POD[]> {
    const result: Record<string, POD[]> = {};
    for (const [podName, podSchema] of Object.entries(this.schema.pods)) {
      result[podName] = PodSpec.create(podSchema).query(pods).matches;
    }
    return result as Record<keyof P["pods"], POD[]>;
  }
}

/**
 * Export for convenience.
 */
export const proofRequest = ProofRequestSpec.create;

/**
 * Generates a {@link ProofRequest}.
 *
 * @param request The PodspecProofRequest to derive the ProofRequest from.
 * @returns A ProofRequest.
 */
function makeProofRequest(request: PodspecProofRequest): ProofRequest {
  const pods: Record<PODName, GPCProofObjectConfig> = {};
  const membershipLists: PODMembershipLists = {};
  const tuples: Record<PODName, GPCProofTupleConfig> = {};

  for (const [podName, podSchema] of Object.entries(request.pods)) {
    const podConfig: GPCProofObjectConfig = { entries: {} };

    for (const [entryName, schema] of Object.entries(podSchema.entries)) {
      const entrySchema =
        schema.type === "optional" ? schema.innerType : schema;
      const entryConfig: GPCProofEntryConfig = {
        isRevealed: entrySchema.isRevealed ?? false,
        isMemberOf: entrySchema.isMemberOf
          ? `allowlist_${podName}_${entryName}`
          : undefined,
        isNotMemberOf: entrySchema.isNotMemberOf
          ? `blocklist_${podName}_${entryName}`
          : undefined,
        ...(entrySchema.type === "cryptographic" || entrySchema.type === "int"
          ? { inRange: entrySchema.inRange }
          : {}),
        ...(entrySchema.type === "cryptographic" && entrySchema.isOwnerID
          ? { isOwnerID: true }
          : {})
      };
      podConfig.entries[entryName] = entryConfig;

      if (entrySchema.isMemberOf) {
        membershipLists[`allowlist_${podName}_${entryName}`] =
          entrySchema.isMemberOf;
      }
      if (entrySchema.isNotMemberOf) {
        membershipLists[`blocklist_${podName}_${entryName}`] =
          entrySchema.isNotMemberOf;
      }
    }
    pods[podName] = podConfig;

    for (const entriesTupleSchema of podSchema.tuples ?? []) {
      const tupleName = `tuple_${podName}_entries_${entriesTupleSchema.entries.join(
        "_"
      )}`;
      tuples[tupleName] = {
        entries: entriesTupleSchema.entries.map(
          (entryName) => `${podName}.${entryName}` satisfies PODEntryIdentifier
        ),
        isMemberOf: entriesTupleSchema.isMemberOf
          ? `allowlist_${tupleName}`
          : undefined,
        isNotMemberOf: entriesTupleSchema.isNotMemberOf
          ? `blocklist_${tupleName}`
          : undefined
      } satisfies GPCProofTupleConfig;
      if (entriesTupleSchema.isMemberOf) {
        membershipLists[`allowlist_${tupleName}`] =
          entriesTupleSchema.isMemberOf;
      }
      if (entriesTupleSchema.isNotMemberOf) {
        membershipLists[`blocklist_${tupleName}`] =
          entriesTupleSchema.isNotMemberOf;
      }
    }
  }

  return {
    proofConfig: {
      pods,
      tuples
    },
    membershipLists,
    watermark: request.watermark,
    externalNullifier: request.externalNullifier
  } satisfies ProofRequest;
}
