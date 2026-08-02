export interface ArchaeologyHiscore {
  rank: number;
  level: number;
  xp: number;
  source: string;
}

const ARCHAEOLOGY_LINE = 28; // Overall is line 0; Archaeology is skill id 27.
const ARCHAEOLOGY_SKILL_ID = 27;

const hasDevProxy = (): boolean =>
  ["localhost", "127.0.0.1"].includes(window.location.hostname);

const parseHiscoresText = (body: string): Omit<ArchaeologyHiscore, "source"> => {
  const values = body.trim().split(/\r?\n/)[ARCHAEOLOGY_LINE]?.split(",").map(Number);
  if (!values || values.length < 3 || values.some(Number.isNaN)) {
    throw new Error("Hiscores did not include Archaeology.");
  }
  return { rank: values[0], level: values[1], xp: values[2] };
};

const parseRuneMetrics = (body: string): Omit<ArchaeologyHiscore, "source"> => {
  const profile = JSON.parse(body);
  if (profile.error) {
    throw new Error(
      profile.error === "PROFILE_PRIVATE"
        ? "That RuneMetrics profile is private."
        : "RuneMetrics has no profile for that name.",
    );
  }
  const skill = (profile.skillvalues ?? []).find(
    (entry: { id: number }) => entry.id === ARCHAEOLOGY_SKILL_ID,
  );
  if (!skill) throw new Error("RuneMetrics did not include Archaeology.");
  // RuneMetrics reports XP in tenths.
  return { rank: Number(skill.rank ?? 0), level: skill.level, xp: Math.round(skill.xp / 10) };
};

interface Attempt {
  label: string;
  url: string;
  parse: (body: string) => Omit<ArchaeologyHiscore, "source">;
}

const buildAttempts = (name: string): Attempt[] => {
  const player = encodeURIComponent(name.trim());
  const attempts: Attempt[] = [];

  if (hasDevProxy()) {
    attempts.push(
      {
        label: "hiscores",
        url: `/rs-hiscores?player=${player}`,
        parse: parseHiscoresText,
      },
      {
        label: "RuneMetrics",
        url: `/rs-runemetrics?user=${player}&activities=0`,
        parse: parseRuneMetrics,
      },
    );
  }

  const hiscores = `https://secure.runescape.com/m=hiscore/index_lite.ws?player=${player}`;
  const runemetrics = `https://apps.runescape.com/runemetrics/profile/profile?user=${player}&activities=0`;

  attempts.push(
    { label: "hiscores", url: hiscores, parse: parseHiscoresText },
    {
      label: "hiscores (proxy)",
      url: `https://corsproxy.io/?url=${encodeURIComponent(hiscores)}`,
      parse: parseHiscoresText,
    },
    {
      label: "RuneMetrics (proxy)",
      url: `https://corsproxy.io/?url=${encodeURIComponent(runemetrics)}`,
      parse: parseRuneMetrics,
    },
  );

  return attempts;
};

export const fetchArchaeologyHiscore = async (
  displayName: string,
): Promise<ArchaeologyHiscore> => {
  if (!displayName.trim()) throw new Error("Enter your RuneScape display name first.");

  let lastMessage = "Could not reach the hiscores.";

  for (const attempt of buildAttempts(displayName)) {
    try {
      const response = await fetch(attempt.url);
      if (response.status === 404) {
        lastMessage = "That name was not found on the hiscores.";
        continue;
      }
      if (!response.ok) {
        lastMessage = `${attempt.label} returned ${response.status}.`;
        continue;
      }
      return { ...attempt.parse(await response.text()), source: attempt.label };
    } catch (error) {
      lastMessage =
        error instanceof Error && error.message && !error.message.includes("fetch")
          ? error.message
          : `${attempt.label} was blocked by the browser.`;
    }
  }

  throw new Error(`${lastMessage} Enter your level and XP manually instead.`);
};
