// SPDX-License-Identifier: AGPL-3.0-only
// The crossed-camera icon for a person with protected identity (ADR 0022),
// shown to viewers allowed to see them. Tapping it explains what it means;
// screen readers get the explanation as the label.

import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Line, Path, Rect } from "react-native-svg";
import { useTranslations } from "use-intl";

import { useTheme } from "../theme.ts";

export function CrossedCamera({ size = 16, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}>
      <Rect x={2} y={7} width={14} height={11} rx={2} />
      <Path d="M16 11l6-3v9l-6-3" strokeLinejoin="round" />
      <Line x1={3} y1={3} x2={21} y2={21} strokeLinecap="round" />
    </Svg>
  );
}

export function ProtectedBadge() {
  const t = useTranslations("protected");
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("tooltip")}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        hitSlop={14}
        testID="protected-badge"
      >
        <CrossedCamera color={theme.colors.danger} />
      </Pressable>
      {open ? (
        <Text style={{ color: theme.colors.muted, fontSize: 13, marginTop: 4 }}>
          {t("tooltip")}
        </Text>
      ) : null}
    </View>
  );
}
