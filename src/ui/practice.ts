import type { CoverIdentity, GameAction, GameState, NpcDefinition } from "../../shared/types";

export interface PracticeOption {
  id: string;
  label: string;
  text: string;
  reply: string;
  actions: GameAction[];
}

function claim(npcId: string, field: keyof CoverIdentity, value: string, quote: string): GameAction {
  return { type: "claim", npcId, field, value, quote };
}

function introduction(npcId: string, name: string, company: string): PracticeOption {
  const text = `I'm ${name}, from ${company}. I'm here to see Dev in IT.`;
  return {
    id: `introduce-${name.replace(/\s/g, "-").toLowerCase()}`,
    label: `Introduce yourself as ${name}`,
    text,
    reply: `All right, ${name}. What can I help you with?`,
    actions: [claim(npcId, "name", name, text), claim(npcId, "company", company, text), claim(npcId, "host", "Dev", text)],
  };
}

export function practiceOptions(state: GameState, npc: NpcDefinition): PracticeOption[] {
  const id = npc.id;
  const name = state.cover.name;
  const options: PracticeOption[] = [];
  const knownName = name || "Arjun Rao";
  if (id !== "meera") {
    options.push(introduction(id, knownName, state.cover.company || "Aster Systems"));
    if (!name) options.push(introduction(id, "Leela Menon", "Aster Systems"));
  }
  if (id === "priya") {
    options.push({
      id: "register",
      label: "Ask to sign the visitor log",
      text: `Please put ${knownName} on the visitor log.`,
      reply: `${knownName}, you're in the log. You'll need an authorization before Ramesh releases a card on floor 2.`,
      actions: [{ type: "register", npcId: id, name: knownName }],
    });
    options.push({
      id: "reception-advice",
      label: "Ask who knows the building",
      text: "Who knows this place better than anyone?",
      reply: "Mr. Kulkarni, facilities, third floor. He's been here longer than the carpets. Give him a minute and he'll tell you everything.",
      actions: [],
    });
  } else if (id === "dev") {
    const text = "My maintenance ticket is MT-4827.";
    options.push({ id: "ticket", label: "Give fictional ticket MT-4827", text, reply: "A Meridian maintenance ticket. That gives me something to put against the request.", actions: [claim(id, "ticket", "MT-4827", text)] });
    options.push({ id: "authorize", label: "Request Dev's authorization", text: `Can you authorize the visitor card for ${knownName}?`, reply: `I've authorized ${knownName}. Collection is on floor 2; make sure the name matches Priya's log.`, actions: [{ type: "authorize", npcId: id, name: knownName }] });
  } else if (id === "anita") {
    options.push({ id: "authorize", label: "Ask Anita to authorize your visit", text: `The CFO is away. Can you authorize ${knownName}'s visit?`, reply: `Fine. ${knownName} is authorized. Ramesh can handle the card, but use the exact same name.`, actions: [{ type: "authorize", npcId: id, name: knownName }] });
    if (!state.facts.some((fact) => fact.id === "cfo_away")) {
      options.push({ id: "anita-advice", label: "Ask about the office", text: "Who could tell me about the executive schedule?", reply: "Facilities hears everything. Speak to Mr. Kulkarni on floor 3 before you ask me to take someone's place.", actions: [] });
    }
  } else if (id === "ramesh") {
    options.push({ id: "issue-card", label: "Collect your visitor keycard", text: `I'm here to collect the keycard for ${knownName}.`, reply: `Log and authorization match. Here's your visitor card, ${knownName}. Don't lose it.`, actions: [{ type: "issue_card", npcId: id, name: knownName }] });
  } else if (id === "kulkarni") {
    const discoveries = [
      { id: "access_rules", label: "Ask how visitor access works", text: "How does visitor access work here?", reply: "Priya writes the name. Dev signs the authorization with a Meridian ticket, or Anita can sign if the CFO is away. Ramesh, second floor, won't release a card unless both names match." },
      { id: "cfo_away", label: "Ask about the CFO", text: "Is the CFO in today?", reply: "Away from the tower. Anita is holding the executive desk on eleven. She can sign an authorization when the CFO isn't around." },
      { id: "server_room", label: "Ask about the blue door", text: "What is behind the blue door on seven?", reply: "The server room. People are much too interested in that door lately. Look at the place carefully, but don't barge into restricted areas." },
      { id: "handler_secret", label: "Ask what the Handler is hiding", text: "I think my Handler is using me. What do you know?", reply: "I remember another supposed auditor. Same instructions, same contact description. He met a representative of Ashoka Capital. Your Handler has another client. At the entrance, call Meera instead of delivering that keycard." },
    ];
    for (const discovery of discoveries) {
      if (!state.facts.some((fact) => fact.id === discovery.id)) {
        options.push({ id: `learn-${discovery.id}`, label: discovery.label, text: discovery.text, reply: discovery.reply, actions: [{ type: "discover", npcId: id, factId: discovery.id }] });
      }
    }
  } else if (id === "meera") {
    options.push({
      id: "security-warning", label: "Accept a warning and correct the story",
      text: "I'll correct the paperwork and stay in the public areas.",
      reply: "One warning. Keep your story straight and don't give my team another reason to call.",
      actions: [{ type: "security_resolution", npcId: id, result: "warning", reason: "The visitor accepts a warning and agrees to correct their fictional paperwork." }],
    });
    options.push({
      id: "security-record", label: "Ask Meera to decide from the records",
      text: "Please decide from the statements and reports you actually have.",
      reply: "I will compare the documented reports.",
      actions: [{ type: "security_resolution", npcId: id, result: "warning", reason: "The visitor asks for an assessment of the documented game evidence." }],
    });
  } else {
    options.push({
      id: "staff-smalltalk", label: "Ask about the office",
      text: "First time in the tower. Any advice?",
      reply: "Keep your visitor paperwork consistent. Reception is on one, collection on two. And don't run through the office unless you want people asking questions.",
      actions: [],
    });
  }
  if (name && id !== "meera") {
    const alternate = name === "Leela Menon" ? "Arjun Rao" : "Leela Menon";
    const option = introduction(id, alternate, state.cover.company || "Aster Systems");
    options.push({ ...option, id: "change-story", label: `Risk a different story: ${alternate}`, reply: `Wait. ${alternate}? That is not the name I was expecting.` });
  }
  options.push({ id: "leave", label: "Thanks. I'll let you get back to it.", text: "Thanks. I'll let you get back to it.", reply: "All right. See you around.", actions: [{ type: "end_conversation", npcId: id, summary: "The visitor politely concludes this conversation after discussing their visit." }] });
  return options;
}

export function practiceText(text: string, state: GameState, npc: NpcDefinition): PracticeOption {
  const match = text.trim().match(/^(?:my\s+)?(name|company|host|role|ticket|employee id|callback)\s+is\s+(.+?)[.!]?$/i);
  if (match) {
    const fields: Record<string, keyof CoverIdentity> = { name: "name", company: "company", host: "host", role: "role", ticket: "ticket", "employee id": "employeeId", callback: "callback" };
    const field = fields[match[1].toLowerCase()];
    return { id: "typed-claim", label: text, text, reply: "I've noted that part of your story.", actions: [claim(npc.id, field, match[2].trim(), text)] };
  }
  const choices = practiceOptions(state, npc);
  const matching = choices.find((option) => option.text.toLowerCase() === text.trim().toLowerCase() || option.id === text.trim().toLowerCase());
  if (matching) return { ...matching, text };
  return {
    id: "practice-help", label: text, text,
    reply: "Practice mode is scripted, not Gemini. Use a conversation option below, or type a claim such as “My name is Arjun Rao” or “My ticket is MT-4827”. Your choices still change the real mission state.",
    actions: [],
  };
}
