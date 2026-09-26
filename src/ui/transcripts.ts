export class TranscriptAssembler {
  private pending: Record<"player" | "npc", string> = { player: "", npc: "" };
  private lastFinal: Record<"player" | "npc", string> = { player: "", npc: "" };

  receive(speaker: "player" | "npc", text: string, final: boolean): { text: string; commit: boolean } {
    if (final && !this.pending[speaker] && this.lastFinal[speaker] === text) return { text, commit: false };
    // VoiceClient emits cumulative snapshots, including corrected interim words.
    const merged = text;
    if (final) {
      this.pending[speaker] = "";
      this.lastFinal[speaker] = merged;
    } else {
      this.pending[speaker] = merged;
    }
    return { text: merged, commit: final && merged.trim().length > 0 };
  }

  finish(): { speaker: "player" | "npc"; text: string }[] {
    const entries: { speaker: "player" | "npc"; text: string }[] = [];
    for (const speaker of ["player", "npc"] as const) {
      const text = this.pending[speaker].trim();
      if (text) entries.push({ speaker, text });
      this.pending[speaker] = "";
      this.lastFinal[speaker] = "";
    }
    return entries;
  }

  clear(): void {
    this.pending = { player: "", npc: "" };
    this.lastFinal = { player: "", npc: "" };
  }
}
