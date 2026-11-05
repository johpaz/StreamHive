import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Stage, MonitorAudio } from "./src/Stage";
import type {
  MediaParticipant,
  MediaRoom,
  MediaTrack,
  Publication,
} from "./src/media";
import type { Asset } from "./src/types";
import { initialProgram } from "./src/types";

const person = (identity: string, name: string): MediaParticipant =>
  ({
    identity,
    name,
    trackPublications: new Map([
      [
        "camera",
        {
          trackSid: `${identity}-video`,
          kind: "video",
          source: "camera",
          isMuted: false,
          track: {} as MediaTrack,
        },
      ],
      [
        "microphone",
        {
          trackSid: `${identity}-audio`,
          kind: "audio",
          source: "microphone",
          isMuted: false,
          track: {} as MediaTrack,
        },
      ],
    ]) as Map<string, Publication>,
  }) as MediaParticipant;
const room = {
  localParticipant: person("host", "Host"),
  remoteParticipants: new Map([
    ["guest", person("guest", "Visible guest")],
    ["backstage", person("backstage", "Private backstage name")],
  ]),
} as MediaRoom;

describe("rendered program versus conversation monitor", () => {
  it("only mounts audio and video elements for the selected program", () => {
    const html = renderToStaticMarkup(
      <Stage
        program={{ ...initialProgram, identities: ["guest"] }}
        room={room}
        renderer
      />,
    );
    expect((html.match(/<audio/g) || []).length).toBe(1);
    expect((html.match(/<video/g) || []).length).toBe(1);
    expect(html).toContain("Visible guest");
    expect(html).not.toContain("Private backstage name");
  });
  it("renders a background-only scene and uses scoped renderer URLs", () => {
    const bg: Asset = {
      id: "backdrop",
      name: "Backdrop",
      filename: "backdrop.png",
      mime: "image/png",
      kind: "image",
      bytes: 100,
      created: 0,
    };
    const html = renderToStaticMarkup(
      <Stage
        program={{ ...initialProgram, background_asset: bg.id }}
        assets={[bg]}
        room={null}
        renderer
        renderToken="scope"
      />,
    );
    expect(html).toContain('class="stage-background"');
    expect(html).toContain("/api/v1/assets/backdrop?render_token=scope");
    expect(html).not.toContain("Este es tu escenario");
    expect(html).not.toContain("<video");
  });
  it("unmounts all audio when the program becomes empty", () => {
    const html = renderToStaticMarkup(
      <Stage program={initialProgram} room={room} renderer />,
    );
    expect(html).not.toContain("<audio");
    expect(html).not.toContain("<video");
  });
  it("the studio preview never duplicates monitored audio", () => {
    const html = renderToStaticMarkup(
      <Stage
        program={{ ...initialProgram, identities: ["guest"] }}
        room={room}
      />,
    );
    expect(html).not.toContain("<audio");
    const monitor = renderToStaticMarkup(<MonitorAudio room={room} />);
    expect((monitor.match(/<audio/g) || []).length).toBe(2);
  });
});
