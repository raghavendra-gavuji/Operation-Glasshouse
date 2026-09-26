import type { FloorPlan, Room, TileKind } from "../../shared/types";
import { NPCS } from "../../shared/story";
import { SeededRandom } from "./random";

export const FLOOR_WIDTH = 30;
export const FLOOR_HEIGHT = 26;

interface FloorDescription {
  name: string;
  subtitle: string;
  rooms: readonly [string, string, string, string, string, string];
  restricted: readonly number[];
  accent: string;
}

const FLOOR_DESCRIPTIONS: readonly FloorDescription[] = [
  {
    name: "Reception",
    subtitle: "Visitor registration, the lobby, and the way back out",
    rooms: ["Visitor lounge", "Security records", "Lobby cubicles", "Meeting suites", "Reception", "Refreshments"],
    restricted: [1],
    accent: "#bc9568",
  },
  {
    name: "Keycard collection",
    subtitle: "Ramesh checks the log AND an authorization here",
    rooms: ["Visitor waiting", "Badge archive", "Collection desk", "Security station", "Pantry", "Restrooms"],
    restricted: [1, 3],
    accent: "#c2ad68",
  },
  {
    name: "Facilities",
    subtitle: "A little tea, a little history, and Mr. Kulkarni",
    rooms: ["Facilities pantry", "Maintenance stores", "Facilities office", "Print room", "Restrooms", "Staff cubicles"],
    restricted: [1],
    accent: "#a7aa76",
  },
  {
    name: "IT services",
    subtitle: "Dev's fictional ticket and employee-ID authorization route",
    rooms: ["IT service desk", "Network lab", "Engineering cubicles", "Project room", "Pantry", "Restrooms"],
    restricted: [1],
    accent: "#71a5a4",
  },
  {
    name: "Risk and compliance",
    subtitle: "Quiet analysis and a very busy printer",
    rooms: ["Risk analysts", "Compliance records", "Research cubicles", "Policy boardroom", "Pantry", "Restrooms"],
    restricted: [1],
    accent: "#899daf",
  },
  {
    name: "People operations",
    subtitle: "Payroll, learning, and a corridor full of appointments",
    rooms: ["People services", "Payroll records", "Recruiting cubicles", "Learning room", "Pantry", "Restrooms"],
    restricted: [1],
    accent: "#a497b4",
  },
  {
    name: "Infrastructure",
    subtitle: "The blue door: optional reconnaissance, not collection",
    rooms: ["Systems support", "Blue-door server room", "Infrastructure cubicles", "Operations room", "Pantry", "Restrooms"],
    restricted: [1, 3],
    accent: "#628fba",
  },
  {
    name: "Corporate finance",
    subtitle: "Reconciliations wait for nobody",
    rooms: ["Accounts office", "Treasury records", "Finance cubicles", "Reporting room", "Pantry", "Restrooms"],
    restricted: [1],
    accent: "#8dada2",
  },
  {
    name: "Client partnerships",
    subtitle: "Visitors, presentations, and overheard small talk",
    rooms: ["Client services", "Contract archive", "Design cubicles", "Client boardroom", "Pantry", "Restrooms"],
    restricted: [1],
    accent: "#b08d9d",
  },
  {
    name: "Legal and audit",
    subtitle: "Paper trails outlast conversations",
    rooms: ["Legal reception", "Records archive", "Audit cubicles", "Review boardroom", "Pantry", "Restrooms"],
    restricted: [1],
    accent: "#ad987f",
  },
  {
    name: "Executive offices",
    subtitle: "Anita keeps the schedule while Rajan Mehta is away",
    rooms: ["Anita's office", "Rajan Mehta's office", "Executive waiting", "Executive boardroom", "Pantry", "Restrooms"],
    restricted: [1, 3],
    accent: "#a28eb8",
  },
  {
    name: "Strategy and board",
    subtitle: "A long view of the city and a short agenda",
    rooms: ["Board services", "Strategy archive", "Planning cubicles", "Main boardroom", "Pantry", "Restrooms"],
    restricted: [1],
    accent: "#bbad82",
  },
];

const ROOM_RECTS = [
  { x: 1, y: 1, width: 12, height: 7, doorX: 12, doorY: 4 },
  { x: 17, y: 1, width: 12, height: 7, doorX: 17, doorY: 4 },
  { x: 1, y: 9, width: 12, height: 8, doorX: 12, doorY: 12 },
  { x: 17, y: 9, width: 12, height: 8, doorX: 17, doorY: 12 },
  { x: 1, y: 18, width: 12, height: 7, doorX: 12, doorY: 21 },
  { x: 17, y: 18, width: 12, height: 7, doorX: 17, doorY: 21 },
] as const;

export function createFloors(seed: number): FloorPlan[] {
  const random = new SeededRandom(seed ^ 0x4d455249);
  return FLOOR_DESCRIPTIONS.map((description, floorIndex) => {
    const id = floorIndex + 1;
    const tiles: TileKind[] = Array<TileKind>(FLOOR_WIDTH * FLOOR_HEIGHT).fill("floor");
    const set = (x: number, y: number, tile: TileKind): void => {
      tiles[y * FLOOR_WIDTH + x] = tile;
    };
    for (let y = 0; y < FLOOR_HEIGHT; y += 1) {
      for (let x = 0; x < FLOOR_WIDTH; x += 1) {
        if (x === 0 || y === 0 || x === FLOOR_WIDTH - 1 || y === FLOOR_HEIGHT - 1) set(x, y, "wall");
      }
    }
    const rooms: Room[] = ROOM_RECTS.map((rect, index) => {
      const room: Room = {
        id: id === 7 && index === 1 ? "server-room" : `floor-${id}-room-${index + 1}`,
        name: description.rooms[index],
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        restricted: description.restricted.includes(index),
        color: id === 7 && index === 1 ? "#487daf" : description.accent,
      };
      for (let y = rect.y; y < rect.y + rect.height; y += 1) {
        for (let x = rect.x; x < rect.x + rect.width; x += 1) {
          const edge = x === rect.x || y === rect.y
            || x === rect.x + rect.width - 1 || y === rect.y + rect.height - 1;
          set(x, y, edge ? "wall" : "carpet");
        }
      }
      set(rect.doorX, rect.doorY, "door");
      const deskWidth = random.next() > 0.5 ? 3 : 2;
      for (let offset = 0; offset < deskWidth; offset += 1) {
        set(rect.x + 2 + offset, rect.y + 1, "desk");
        set(rect.x + 7 + offset, rect.y + rect.height - 2, "desk");
      }
      set(rect.x + rect.width - 2, rect.y + 1, "plant");
      return room;
    });
    rooms.push(
      { id: `floor-${id}-core`, name: "Elevator core", x: 13, y: 21, width: 4, height: 4, restricted: false, color: "#64747b" },
      { id: `floor-${id}-corridor`, name: "Central corridor", x: 13, y: 1, width: 4, height: 20, restricted: false, color: "#82918f" },
      { id: `floor-${id}-cross-north`, name: "North cross corridor", x: 1, y: 8, width: 28, height: 1, restricted: false, color: "#82918f" },
      { id: `floor-${id}-cross-south`, name: "South cross corridor", x: 1, y: 17, width: 28, height: 1, restricted: false, color: "#82918f" },
    );
    for (const x of [14, 15]) for (const y of [22, 23]) set(x, y, "elevator");
    if (id === 1) {
      set(14, 24, "exit");
      set(15, 24, "exit");
    }
    for (const npc of NPCS.filter((definition) => definition.floor === id)) {
      set(Math.floor(npc.home.x), Math.floor(npc.home.y), "carpet");
    }
    return {
      id,
      name: description.name,
      subtitle: description.subtitle,
      width: FLOOR_WIDTH,
      height: FLOOR_HEIGHT,
      tiles,
      rooms,
      spawn: { x: 14.5, y: 21.5 },
      elevator: { x: 15.5, y: 23.5 },
      ...(id === 1 ? { exit: { x: 14.5, y: 24.5 } } : {}),
      palette: {
        floor: floorIndex % 2 === 0 ? "#909b98" : "#899797",
        wall: "#46545b",
        accent: description.accent,
      },
    };
  });
}
