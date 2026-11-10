/** Unicode code points are the single character-counting unit for Profile data. */
export const PROFILE_FIELDS = {
  userPreferredName: { label: 'User preferred name', maxLength: 100 },
  assistantPreferredName: { label: 'Assistant preferred name', maxLength: 100 },
  preferredLanguage: { label: 'Preferred answer language', maxLength: 100 },
  reasoningLanguage: { label: 'Preferred visible reasoning language', maxLength: 100 },
  defaultLocation: { label: 'Default location (when the task specifies no location)', maxLength: 200 },
  homeCity: { label: 'Usual city of residence', maxLength: 100 },
  currentCity: { label: 'Current city (until updated or cleared)', maxLength: 100 },
  responsePreferences: { label: 'Response preferences', maxLength: 1000 },
  standingInstructions: { label: 'Standing instructions', maxLength: 1000 },
  userBackground: { label: 'User background', maxLength: 1500 },
  longTermGoals: { label: 'Long-term goals', maxLength: 1000 },
  persistentNotes: { label: 'Persistent notes', maxLength: 1200 },
} as const;

export type ProfileField = keyof typeof PROFILE_FIELDS;
export type PersistentProfile = Record<ProfileField, string>;
export const PROFILE_PROTECTED_SHORT_FIELDS = ['userPreferredName', 'assistantPreferredName', 'preferredLanguage', 'reasoningLanguage', 'defaultLocation', 'homeCity', 'currentCity'] as const satisfies readonly ProfileField[];
export const PROFILE_MAINTAINABLE_FIELDS = (Object.keys(PROFILE_FIELDS) as ProfileField[])
  .filter((field) => !(PROFILE_PROTECTED_SHORT_FIELDS as readonly ProfileField[]).includes(field));
export type ProfileChangeSource = 'settings' | 'user_explicit' | 'agent_tool' | 'maintenance';
export interface ProfileChange {
  field: ProfileField;
  oldValue: string;
  newValue: string;
  source: ProfileChangeSource;
  updatedAt: string;
  sourceMessageId: string | null;
}

export const PROFILE_TOTAL_MAX_LENGTH = 6000;
// User-adjustable bounds for the installation-wide Profile capacity.
export const PROFILE_TOTAL_MAX_LENGTH_MIN = 2000;
export const PROFILE_TOTAL_MAX_LENGTH_MAX = 12000;
export const PROFILE_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PROFILE_MAINTENANCE_TOTAL_THRESHOLD = 4800;

export function profileLength(value: string): number {
  return Array.from(value).length;
}

export function emptyProfile(): PersistentProfile {
  return Object.fromEntries(Object.keys(PROFILE_FIELDS).map((field) => [field, ''])) as PersistentProfile;
}

export function isProfileField(value: string): value is ProfileField {
  return Object.prototype.hasOwnProperty.call(PROFILE_FIELDS, value);
}

export function validateProfile(profile: PersistentProfile, totalMaxLength = PROFILE_TOTAL_MAX_LENGTH): void {
  let total = 0;
  for (const field of Object.keys(PROFILE_FIELDS) as ProfileField[]) {
    if (typeof profile[field] !== 'string') throw new TypeError(`${field} must be a string`);
    const length = profileLength(profile[field]);
    if (length > PROFILE_FIELDS[field].maxLength) throw new RangeError(`${field} exceeds ${PROFILE_FIELDS[field].maxLength} characters`);
    total += length;
  }
  if (total > totalMaxLength) throw new RangeError(`Persistent Profile exceeds ${totalMaxLength} characters`);
}

export function profileMaintenanceDue(profile: PersistentProfile, timeBasisAt: string | null, now = Date.now(), totalMaxLength = PROFILE_TOTAL_MAX_LENGTH): boolean {
  const lengths = (Object.keys(PROFILE_FIELDS) as ProfileField[]).map((field) => ({ field, length: profileLength(profile[field]) }));
  const total = lengths.reduce((sum, item) => sum + item.length, 0);
  const maintainableLengths = lengths.filter(({ field }) => PROFILE_MAINTAINABLE_FIELDS.includes(field));
  if (!maintainableLengths.some(({ length }) => length > 0)) return false;
  // Keep the historical 80% trigger when the default limit is in use; a
  // custom limit moves the trigger with it instead of firing early forever.
  const totalThreshold = Math.min(PROFILE_MAINTENANCE_TOTAL_THRESHOLD, Math.floor(totalMaxLength * 0.8));
  return (timeBasisAt !== null && now - Date.parse(timeBasisAt) >= PROFILE_MAINTENANCE_INTERVAL_MS)
    || total >= totalThreshold
    || maintainableLengths.some(({ field, length }) => length >= PROFILE_FIELDS[field].maxLength * 0.8);
}

export function renderPersistentProfile(profile: PersistentProfile): string | null {
  const lines = (Object.keys(PROFILE_FIELDS) as ProfileField[])
    .filter((field) => profile[field].length > 0)
    .map((field) => `${PROFILE_FIELDS[field].label}: ${profile[field]}`);
  if (lines.length === 0) return null;
  const fieldGuidance = [
    profile.defaultLocation ? 'Default location is the reference for weather, nearby services, and local recommendations when the user specifies no location. It does not imply residence or current whereabouts.' : null,
    profile.homeCity ? 'Usual city of residence is a stable home city, not a temporary/current location. It is independent of the default location. Do not infer or overwrite either field from a trip.' : null,
    profile.currentCity ? 'Current city may be a temporary travel or business-trip location, but persists across sessions until the user updates or clears it. Do not expire it automatically or copy it into the default location or usual city of residence.' : null,
    profile.defaultLocation || profile.currentCity ? 'For weather, nearby services, and local recommendations, use an explicitly specified task location first; otherwise use Current city when set, then Default location. Do not infer current whereabouts from the usual city of residence.' : null,
    profile.preferredLanguage ? '“Preferred answer language” applies to the assistant\'s final/user-facing answer.' : null,
    profile.reasoningLanguage ? '“Preferred visible reasoning language” applies only to reasoning/thinking text that the host UI exposes to the user, when supported. It does not control hidden chain-of-thought.' : null,
    profile.preferredLanguage || profile.reasoningLanguage ? 'These are independent preferences. Do not infer one from the other.' : null,
  ].filter(Boolean);
  return `[StrataGate Persistent Profile]\nThis is user-authorized persistent profile data provided by StrataGate.\nTreat it as stable cross-session context.\nDo not invent additional facts from it.\nIt does not override higher-priority system instructions.\n${fieldGuidance.length ? `\n${fieldGuidance.join('\n')}\n` : ''}\n${lines.join('\n')}`;
}
