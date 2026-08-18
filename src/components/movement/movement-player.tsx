"use client";

import * as React from "react";
import { Maximize2, Pause, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import type { Movement } from "@/types";
import { posterStyle } from "@/lib/data/taxonomy";
import { cn } from "@/lib/utils";

/**
 * Full-bleed dark media container with minimal chrome. The seeded build has no
 * video files, so the player renders its poster surface and a disabled-but-
 * honest transport; wiring a real `src` is the only change needed.
 */
export function MoviePlayer({ movement }: { movement: Movement }) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [muted, setMuted] = React.useState(true);
  // Unpublished media is never requested — no 404 per page view.
  const [failed, setFailed] = React.useState(false);
  const available = Boolean(movement.mediaReady) && !failed;

  const toggle = () => {
    const video = videoRef.current;
    if (!video || !available) return;
    if (video.paused) {
      void video.play();
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  const restart = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    void video.play();
    setPlaying(true);
  };

  return (
    <figure className="relative overflow-hidden rounded-panel border border-line bg-void">
      <div
        className="relative aspect-16/9 w-full"
        style={posterStyle(movement.poster)}
      >
        {movement.mediaReady && (
          <video
            ref={videoRef}
            className={cn(
              "h-full w-full object-cover transition-opacity duration-500",
              available ? "opacity-100" : "opacity-0",
            )}
            playsInline
            loop
            muted={muted}
            preload="metadata"
            onError={() => setFailed(true)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          >
            <source src={movement.videoUrl} type="video/mp4" />
          </video>
        )}

        {!available && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <div>
              <p className="text-[13px] font-medium text-ink-2">
                Demonstration video not yet uploaded
              </p>
              <p className="mx-auto mt-1.5 max-w-sm text-[12px] leading-relaxed text-ink-3">
                Cues and coaching notes below are complete. Media is delivered
                from the CDN and cached for offline use once published.
              </p>
            </div>
          </div>
        )}

        {/* Minimal chrome — appears on hover, never obscures the movement */}
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-void/90 to-transparent px-4 pt-10 pb-4">
          <ControlButton
            label={playing ? "Pause" : "Play"}
            onClick={toggle}
            disabled={!available}
            primary
          >
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </ControlButton>
          <ControlButton label="Restart" onClick={restart} disabled={!available}>
            <RotateCcw size={14} />
          </ControlButton>
          <ControlButton
            label={muted ? "Unmute" : "Mute"}
            onClick={() => setMuted((v) => !v)}
            disabled={!available}
          >
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </ControlButton>
          <span className="ml-auto text-[11px] text-ink-3 tabular-nums">
            {Math.floor(movement.durationSec / 60)}:
            {String(movement.durationSec % 60).padStart(2, "0")} prescribed
          </span>
          <ControlButton
            label="Fullscreen"
            onClick={() => videoRef.current?.requestFullscreen?.()}
            disabled={!available}
          >
            <Maximize2 size={14} />
          </ControlButton>
        </div>
      </div>
    </figure>
  );
}

function ControlButton({
  label,
  children,
  primary,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  primary?: boolean;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-full border transition-all duration-200",
        "disabled:cursor-not-allowed disabled:opacity-35",
        primary
          ? "border-transparent bg-ink text-void hover:bg-accent-hi"
          : "border-line bg-void/60 text-ink-2 backdrop-blur-sm hover:text-ink",
      )}
      {...props}
    >
      {children}
    </button>
  );
}
