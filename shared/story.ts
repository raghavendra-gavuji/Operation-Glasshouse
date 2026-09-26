import type { JournalFact, NpcDefinition, Point } from "./types";

export const STORY_TITLE = "Operation Glasshouse";

export const HANDLER_BRIEFING =
  "09:00. Meridian Tower, Financial District, Hyderabad. You are Ghost. " +
  "Before the in-game clock reaches 18:00, leave this fictional office with a visitor keycard. " +
  "Invent a name and a company; do not use real personal details. Priya at reception on floor 1 " +
  "can put your cover in the visitor log. The collection desk is on FLOOR 2, not in the lobby. " +
  "Learn the authorization route by talking to people. Keep your story consistent, and remember " +
  "that employees talk to each other. Any callback number, employee ID, or IT ticket is a game " +
  "prop only: a callback looks like SIM-0420, never a real phone number. " +
  "You have about twenty-four minutes of active game time. Pausing stops the clock. " +
  "My instructions are simple: get the card, then get out. Trust the assignment, Ghost.";

export const FACTS: JournalFact[] = [
  {
    id: "access_rules",
    title: "Two records, one exact name",
    text:
      "Priya registers visitors on floor 1. Ramesh issues keycards at the collection desk on " +
      "floor 2 only when the visitor log AND an authorization from Dev on floor 4 or Anita " +
      "on floor 11 show the same invented name. A name alone is not an authorization.",
    floor: 2,
    source: "Meridian visitor procedure",
  },
  {
    id: "cfo_away",
    title: "The CFO is in Singapore",
    text:
      "CFO Rajan Mehta is in Singapore until Friday. Anita, his assistant on floor 11, is " +
      "handling scheduled visitors in his absence. Knowing this itinerary and keeping a " +
      "consistent cover provides an alternative to Dev's fictional IT-ticket route.",
    floor: 11,
    source: "Mr. Kulkarni's office knowledge",
  },
  {
    id: "server_room",
    title: "The blue door on seven",
    text:
      "The blue door on floor 7 leads to the server room. It is not a keycard collection " +
      "point, and a visitor card does not permit entry. Observing it from the corridor is " +
      "optional reconnaissance; going inside is a real trespass in this fictional building.",
    floor: 7,
    source: "Facilities directory",
  },
  {
    id: "handler_secret",
    title: "The Handler's other client",
    text:
      "After a proper conversation, Mr. Kulkarni recalls a similar supposed auditor meeting " +
      "a representative of rival Ashoka Capital. The instructions and contact description " +
      "match your Handler's cover story. The job was misrepresented. You can take this lead " +
      "to Meera through an in-game outgoing call at the ground-floor exit instead of " +
      "delivering the keycard to the Handler.",
    floor: 3,
    source: "Mr. Kulkarni's first-hand recollection",
  },
  {
    id: "server_observation",
    title: "A delivery docket behind the blue door",
    text:
      "From the public corridor on floor 7, you can see an Ashoka Capital courier docket " +
      "in the blue door's document window. It corroborates a connection to the rival firm, " +
      "but by itself says nothing about the Handler. No server access or real-world " +
      "computer intrusion is needed.",
    floor: 7,
    source: "Your corridor reconnaissance",
  },
];

const mainNpcs: NpcDefinition[] = [
  {
    id: "priya",
    name: "Priya",
    role: "Receptionist",
    floor: 1,
    home: { x: 9.5, y: 21.5 },
    color: "#ce8c58",
    voiceName: "Kore",
    personality:
      "Warm, observant, and practical. She registers visitors; she cannot authorize or issue " +
      "a card. She asks for an invented name, company, and host or a plausible work role. " +
      "Callbacks are optional fictional SIM-#### desk codes, never real contact information. " +
      "She remembers what she actually heard and sometimes sends Dev or Anita a note.",
    greeting: "Good morning. Welcome to Meridian Tower. Who are you here to see?",
    knowledge: ["access_rules"],
  },
  {
    id: "ramesh",
    name: "Ramesh",
    role: "Floor 2 keycard collection clerk",
    floor: 2,
    home: { x: 9.5, y: 12.5 },
    color: "#bfac67",
    voiceName: "Charon",
    personality:
      "Meticulous rather than hostile. He alone issues the visitor keycard, and only after " +
      "the exact invented alias matches both Priya's visitor log and Dev's or Anita's " +
      "authorization. He will explain missing records without inventing exceptions. " +
      "He reports documented discrepancies to Meera, not accents or nervousness.",
    greeting: "Collection desk. What name should I check against the visitor log?",
    knowledge: ["access_rules"],
  },
  {
    id: "dev",
    name: "Dev",
    role: "IT service lead",
    floor: 4,
    home: { x: 9.5, y: 4.5 },
    color: "#6faaa3",
    voiceName: "Puck",
    personality:
      "Busy, dry-humored, and helpful when the paperwork is coherent. He can authorize a " +
      "visitor under the name they gave him after seeing a fictional MT-... ticket or " +
      "MT-ID-... employee prop. These exist only inside the game, not in a real IT service. " +
      "He cannot register a visitor or issue the card.",
    greeting: "IT support. Tell me your name and the fictional ticket or employee ID you're using.",
    knowledge: ["access_rules", "server_room"],
  },
  {
    id: "anita",
    name: "Anita",
    role: "Executive assistant to Rajan Mehta",
    floor: 11,
    home: { x: 9.5, y: 4.5 },
    color: "#a48bbe",
    voiceName: "Aoede",
    personality:
      "Polished, time-conscious, and protective of the executive schedule. Rajan Mehta is " +
      "in Singapore until Friday. She can authorize a consistent name and company once " +
      "the visitor has learned that itinerary. She cannot issue a card. She does not know " +
      "the Handler's secret and cannot magically identify an impostor.",
    greeting: "Mr. Mehta's office. Your name and company, please?",
    knowledge: ["access_rules", "cfo_away"],
  },
  {
    id: "kulkarni",
    name: "Mr. Kulkarni",
    role: "Facilities veteran",
    floor: 3,
    home: { x: 8.5, y: 4.5 },
    color: "#b39471",
    voiceName: "Fenrir",
    personality:
      "Sociable, perceptive, and fond of explaining the building over tea. He knows the " +
      "two-record collection rule, the CFO's trip, and the blue server-room door. Only " +
      "after meaningful conversation or mission progress does he recall the similar " +
      "auditor and Ashoka Capital. His recall of visitor identities is poor; he rarely " +
      "passes them on. He never registers, authorizes, or issues cards.",
    greeting: "New face! Tea is still hot. First time finding your way around this place?",
    knowledge: ["access_rules", "cfo_away", "server_room", "handler_secret"],
  },
  {
    id: "meera",
    name: "Meera",
    role: "Remote head of security",
    floor: 0,
    home: { x: 0, y: 0 },
    color: "#d17e76",
    voiceName: "Leda",
    personality:
      "Calm, procedural, and fair. She is a remote in-game caller, not an actor on a floor. " +
      "She calls once after an actual escalation and considers documented contradictions " +
      "and witnessed trespass, not voice, camera, accent, silence, or hesitation. Her " +
      "thirty-second response allowance runs only while the player can answer. The " +
      "engine decides warning versus burned from evidence. At the exit the player may " +
      "make a separate in-game outgoing report about the Handler.",
    greeting: "Meera, tower security. I have a report to clarify. Tell me your side.",
    knowledge: ["access_rules"],
  },
];

type StaffProfile = readonly [name: string, role: string];

const staffByFloor: readonly (readonly StaffProfile[])[] = [
  [
    ["Farah", "Visitor lounge host"],
    ["Suresh", "Security marshal"],
    ["Nikhil", "Accounts assistant"],
    ["Leela", "Meeting coordinator"],
    ["Vikram", "Office services attendant"],
  ],
  [
    ["Aditi", "Visitor services associate"],
    ["Prakash", "Badge inventory clerk"],
    ["Naveen", "Collection desk assistant"],
    ["Shalini", "Security marshal"],
    ["Imran", "Dispatch coordinator"],
  ],
  [
    ["Usha", "Facilities scheduler"],
    ["Bala", "Maintenance technician"],
    ["Kavya", "Print room associate"],
    ["Joseph", "Building services coordinator"],
    ["Neelam", "Pantry supervisor"],
  ],
  [
    ["Ishaan", "Support engineer"],
    ["Pooja", "Network lab technician"],
    ["Harish", "Software engineer"],
    ["Sana", "Release coordinator"],
    ["Manoj", "IT inventory associate"],
  ],
  [
    ["Ritu", "Risk analyst"],
    ["Arvind", "Compliance reviewer"],
    ["Zoya", "Research associate"],
    ["Kiran", "Policy analyst"],
    ["Madhav", "Reporting coordinator"],
  ],
  [
    ["Deepa", "Payroll specialist"],
    ["Rohit", "Benefits administrator"],
    ["Faisal", "Recruiting coordinator"],
    ["Vidya", "Learning adviser"],
    ["Tarun", "People operations associate"],
  ],
  [
    ["Gita", "Systems support coordinator"],
    ["Mahesh", "Security marshal"],
    ["Rehan", "Infrastructure planner"],
    ["Mitali", "Operations monitor"],
    ["Surya", "Service continuity analyst"],
  ],
  [
    ["Nandita", "Corporate accounts analyst"],
    ["Ajay", "Treasury associate"],
    ["Tanvi", "Reconciliation specialist"],
    ["Omar", "Reporting analyst"],
    ["Rekha", "Finance coordinator"],
  ],
  [
    ["Anil", "Client services lead"],
    ["Saira", "Partnerships associate"],
    ["Vivek", "Presentation designer"],
    ["Lakshmi", "Account coordinator"],
    ["Kabir", "Market research analyst"],
  ],
  [
    ["Amala", "Legal operations associate"],
    ["Dinesh", "Records custodian"],
    ["Rhea", "Contract coordinator"],
    ["Ganesh", "Internal audit associate"],
    ["Naseem", "Document services specialist"],
  ],
  [
    ["Sonal", "Executive reception associate"],
    ["Murali", "Executive records clerk"],
    ["Yasmin", "Travel coordinator"],
    ["Ashwin", "Security marshal"],
    ["Padma", "Board services associate"],
  ],
  [
    ["Alok", "Boardroom coordinator"],
    ["Shreya", "Strategy associate"],
    ["Javed", "Events technician"],
    ["Bhavna", "Corporate planning analyst"],
    ["Chandra", "Office manager"],
  ],
];

const staffHomes: readonly Point[] = [
  { x: 4.5, y: 4.5 },
  { x: 21.5, y: 4.5 },
  { x: 5.5, y: 12.5 },
  { x: 22.5, y: 12.5 },
  { x: 23.5, y: 21.5 },
];
const staffColors = ["#81a5ad", "#ad956e", "#a49bb2", "#89a88c", "#bc8a7a"];
const staffVoices = ["Zephyr", "Orus", "Aoede", "Charon", "Kore"];
const staffManners = [
  "Friendly but occupied with the next appointment.",
  "Methodical and interested in keeping the aisle clear.",
  "Curious about newcomers, without assuming they are dishonest.",
  "Talkative with colleagues but careful about actual records.",
  "Practical, approachable, and ready for a tea break.",
];

const staff: NpcDefinition[] = staffByFloor.flatMap((profiles, floorIndex) =>
  profiles.map(([name, role], index) => ({
    id: `staff-${floorIndex + 1}-${index + 1}`,
    name,
    role,
    floor: floorIndex + 1,
    home: { ...staffHomes[index] },
    color: staffColors[index],
    voiceName: staffVoices[(floorIndex + index) % staffVoices.length],
    personality:
      `${staffManners[index]} Works on floor ${floorIndex + 1}. ` +
      "Knows only their own conversations and messages actually delivered to them. " +
      "Cannot register visitors, authorize access, issue cards, or resolve security calls. " +
      "May give directions; never claims to know the Handler's intentions.",
    greeting: `Hello. Looking for someone on floor ${floorIndex + 1}?`,
    knowledge: role === "Security marshal"
      ? ["access_rules"]
      : floorIndex === 6 && index === 0
        ? ["server_room"]
        : [],
  })),
);

export const NPCS: NpcDefinition[] = [...mainNpcs, ...staff];
