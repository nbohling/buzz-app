import { nip19 } from "nostr-tools";
import type { RelaySession } from "../relay/session";
import { searchedProfiles } from "../relay/profile-search";
import { verifiedProfileFilter } from "../relay/verified-profile";
import { matchPerson } from "../search/person-match";

export const MEMBER_SEARCH_PAGE_SIZE = 30;

/** One bounded server-ranked page; never substitute a scan of cached profiles. */
export async function searchMembers(
  session: RelaySession,
  query: string,
  page: number,
  signal: AbortSignal,
) {
  const text = query.trim();
  if (!text || text.length > 256 || !Number.isSafeInteger(page) || page < 1)
    throw new Error("Enter a name or public key to search.");
  let exact = /^[0-9a-f]{64}$/i.test(text) ? text.toLowerCase() : undefined;
  if (text.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(text);
      if (decoded.type === "npub") exact = decoded.data;
    } catch {
      // An incomplete public key remains an ordinary query while typing.
    }
  }
  const authority = session.profiles.verifiedAuthority?.();
  const events = exact
    ? await session.read(
        [
          { kinds: [0], authors: [exact], limit: MEMBER_SEARCH_PAGE_SIZE },
          // A person with no kind:0 is found by their verified head.
          ...(authority
            ? [verifiedProfileFilter(authority.pubkey, [exact])]
            : []),
        ],
        { signal },
      )
    : await session.searchProfiles(text, {
        limit: MEMBER_SEARCH_PAGE_SIZE,
        page,
        signal,
      });
  signal.throwIfAborted();
  // Names belong to the authority that checked them: one replaced during the
  // read names no one.
  const profiles = searchedProfiles(
    events,
    session.profiles.verifiedAuthority?.() === authority
      ? authority
      : undefined,
  );
  const found = profiles.size;
  if (exact)
    for (const pubkey of profiles.keys())
      if (pubkey !== exact) profiles.delete(pubkey);
  // Rank the relay's page by the shared name rule.
  const score = (name: string) => matchPerson(name, text)?.tier ?? 4;
  return {
    people: [...profiles]
      .map(([pubkey, profile]) => ({ pubkey, ...profile }))
      .sort(
        (a, b) =>
          score(a.name) - score(b.name) ||
          a.name.localeCompare(b.name) ||
          a.pubkey.localeCompare(b.pubkey),
      ),
    more: !exact && found >= MEMBER_SEARCH_PAGE_SIZE,
  };
}
export type MemberSearchResult = Awaited<ReturnType<typeof searchMembers>>;
