// Server-rendered YouTube player relay page.
//
// WHY THIS EXISTS: the packaged AAC shells (Electron desktop → origin
// `app://aac`, Capacitor iPad → `capacitor://localhost`) are not http(s)
// origins. YouTube's IFrame player validates the embed against the values it
// reads *inside the iframe's own JS* — `window.location.origin` (baked into the
// embed URL by the IFrame API) and `document.referrer`. From an app:// /
// capacitor:// origin both are invalid, so the player refuses with error
// 152/153. Rewriting the HTTP Referer/Origin headers in the Electron main
// process does NOT help: those JS values come from the navigation itself, not
// the patched header.
//
// THE FIX: host the player one iframe-level deep inside THIS page, which is
// served from the real https backend. The nested YouTube iframe then sees a
// genuine https origin + referrer, so it plays. The outer app://aac frame
// drives it through a tiny postMessage command protocol relayed here. This is
// the same "framed by app://" pattern used by server/games-static.ts, and it
// fixes Electron AND iPad with zero native code.
//
// Command protocol (parent shell ⇄ this page):
//   parent → page: { type: "yt-cmd", cmd: "toggle" | "restart" | "play" |
//                    "pause" | "seekRelative", seconds?: number }
//   page → parent: { type: "yt-ready" }
//                  { type: "yt-state", playing: boolean }
//                  { type: "yt-error", code: number }

/** A YouTube video id is exactly 11 chars from the URL-safe base64 alphabet. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isValidYoutubeVideoId(id: unknown): id is string {
  return typeof id === "string" && VIDEO_ID_RE.test(id);
}

/**
 * Render the relay HTML for one video. `videoId` MUST already be validated with
 * `isValidYoutubeVideoId` — it is interpolated into a JS string literal, and the
 * strict 11-char URL-safe charset is what makes that injection-safe.
 */
export function renderYoutubeEmbedPage(videoId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Video</title>
    <style>
      html, body { margin: 0; height: 100%; width: 100%; background: #000; overflow: hidden; }
      #player { position: absolute; inset: 0; width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <div id="player"></div>
    <script>
      (function () {
        var VIDEO_ID = "${videoId}";

        // ── Diagnostics ──────────────────────────────────────────────────
        // Error 152/153 = YouTube didn't get a usable Referer. The values it
        // keys off (document.referrer / location.origin) are visible only from
        // inside THIS frame, so surface them: console (shows in the app's
        // DevTools, subframe context) + posted to the parent so the client
        // logs them too. If document.referrer here is empty or "app://aac",
        // the referrer is being stripped before it reaches us.
        var CTX = {
          videoId: VIDEO_ID,
          referrer: document.referrer,
          href: location.href,
          origin: location.origin,
          ua: navigator.userAgent,
        };
        function diag(tag, extra) {
          var payload = { tag: tag };
          for (var k in CTX) payload[k] = CTX[k];
          if (extra) for (var j in extra) payload[j] = extra[j];
          try { console.log("[yt-embed] " + tag, JSON.stringify(payload)); } catch (e) {}
          try { parent.postMessage({ type: "yt-diag", tag: tag, info: payload }, "*"); } catch (e) {}
        }
        diag("boot");

        // Origins allowed to command this player. The packaged shells plus any
        // localhost dev server and our own origin (web build frames same-origin).
        function parentAllowed(origin) {
          if (!origin) return false;
          if (origin === "app://aac") return true;
          if (origin === "capacitor://localhost") return true;
          if (origin === "https://localhost") return true;
          if (origin === location.origin) return true;
          return /^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?$/.test(origin);
        }

        // Commands carry no secrets, so we broadcast events with "*" and gate
        // INbound commands by origin instead.
        function toParent(msg) {
          try { parent.postMessage(msg, "*"); } catch (e) {}
        }

        var player = null;

        window.addEventListener("message", function (ev) {
          if (!parentAllowed(ev.origin)) return;
          var d = ev.data;
          if (!d || d.type !== "yt-cmd" || !player) return;
          try {
            switch (d.cmd) {
              case "toggle":
                if (player.getPlayerState() === 1) player.pauseVideo();
                else player.playVideo();
                break;
              case "seekRelative": {
                var t = player.getCurrentTime() || 0;
                var next = t + (typeof d.seconds === "number" ? d.seconds : 0);
                player.seekTo(Math.max(0, next), true);
                break;
              }
              case "restart":
                player.seekTo(0, true);
                player.playVideo();
                break;
              case "play": player.playVideo(); break;
              case "pause": player.pauseVideo(); break;
            }
          } catch (e) {}
        });

        window.onYouTubeIframeAPIReady = function () {
          diag("api-ready");
          player = new YT.Player("player", {
            videoId: VIDEO_ID,
            width: "100%",
            height: "100%",
            // Privacy-enhanced host. Referrer/origin are now valid https, so it
            // no longer errors the way the direct app:// embed did.
            host: "https://www.youtube-nocookie.com",
            playerVars: {
              autoplay: 1,
              controls: 0,
              modestbranding: 1,
              rel: 0,
              playsinline: 1,
              fs: 0,
            },
            events: {
              onReady: function () { diag("ready"); toParent({ type: "yt-ready" }); },
              onStateChange: function (e) {
                // PLAYING=1, PAUSED=2, ENDED=0
                if (e.data === 1) toParent({ type: "yt-state", playing: true });
                else if (e.data === 2 || e.data === 0) toParent({ type: "yt-state", playing: false });
              },
              onError: function (e) {
                var code = e && e.data;
                // Include the referrer/origin context WITH the error so the one
                // log line tells us whether it's a referrer problem (152/153) vs
                // an embedding/removed problem (100/101/150), and what referrer
                // we actually presented.
                diag("error", { code: code });
                toParent({ type: "yt-error", code: code, ctx: CTX });
              },
            },
          });
        };

        var tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(tag);
      })();
    </script>
  </body>
</html>`;
}
