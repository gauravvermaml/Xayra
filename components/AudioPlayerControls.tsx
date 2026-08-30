import { useCallback, useState } from "react";
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from "react-native";

import { colors } from "../constants/theme";
import { useAudioPlayerControls } from "../services/audio/player";

export type AudioPlayerControlsProps = {
  audioUri: string;
  style?: StyleProp<ViewStyle>;
  /** Smaller variant for tight spaces (e.g. inline in a list card). */
  compact?: boolean;
};

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function AudioPlayerControls({ audioUri, style, compact }: AudioPlayerControlsProps) {
  const player = useAudioPlayerControls(audioUri);
  const [trackWidth, setTrackWidth] = useState(0);

  const handleTrackLayout = useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
    setTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const handleSeek = useCallback(
    (locationX: number) => {
      if (!player.duration || trackWidth <= 0) {
        return;
      }
      const ratio = Math.max(0, Math.min(1, locationX / trackWidth));
      player.seek(ratio * player.duration);
    },
    [player, trackWidth]
  );

  if (!audioUri) {
    return (
      <View style={[styles.container, compact && styles.containerCompact, style]}>
        <Text style={styles.errorText}>No audio available.</Text>
      </View>
    );
  }

  if (player.error) {
    return (
      <View style={[styles.container, compact && styles.containerCompact, style]}>
        <Text style={styles.errorText}>{player.error}</Text>
      </View>
    );
  }

  const progressRatio = player.duration > 0 ? player.currentTime / player.duration : 0;

  return (
    <View style={[styles.container, compact && styles.containerCompact, style]}>
      <Pressable
        onPress={player.toggle}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={({ pressed }) => [
          styles.playButton,
          compact && styles.playButtonCompact,
          pressed && styles.playButtonPressed,
        ]}
      >
        <Text style={styles.playButtonIcon}>{player.isPlaying ? "❚❚" : "▶"}</Text>
      </Pressable>

      <View style={styles.progressColumn}>
        <Pressable
          onLayout={handleTrackLayout}
          onPress={(event) => handleSeek(event.nativeEvent.locationX)}
          style={styles.track}
        >
          <View style={[styles.trackFill, { width: `${progressRatio * 100}%` }]} />
        </Pressable>
        <View style={styles.timeRow}>
          <Text style={styles.timeText}>{formatTime(player.currentTime)}</Text>
          <Text style={styles.timeText}>{formatTime(player.duration)}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 12,
  },
  containerCompact: {
    padding: 8,
    borderRadius: 10,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
  },
  playButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  playButtonCompact: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  playButtonPressed: {
    opacity: 0.8,
  },
  playButtonIcon: {
    color: colors.onAccent,
    fontSize: 14,
  },
  progressColumn: {
    flex: 1,
    gap: 6,
  },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceElevated,
    overflow: "hidden",
  },
  trackFill: {
    height: "100%",
    backgroundColor: colors.accent,
    borderRadius: 3,
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  timeText: {
    color: colors.textMuted,
    fontSize: 11,
  },
});
