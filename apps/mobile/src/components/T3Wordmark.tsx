import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 54 / 79;
  return (
    <Svg
      accessibilityLabel="Acid"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="37 24 54 79"
    >
      <ThemedPath
        d="M64 24C64 24 91 53 91 76A27 27 0 0 1 37 76C37 53 64 24 64 24ZM46 73A18 18 0 0 0 62 93.5A27 27 0 0 1 46 73Z"
        fillRule="evenodd"
        clipRule="evenodd"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
