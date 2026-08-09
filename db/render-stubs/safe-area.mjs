/** react-native-safe-area-context stub — insets are 0 in a headless render. */
import { createElement } from 'react';
import { View } from 'react-native-web';

export const SafeAreaView = ({ children, ...props }) => createElement(View, props, children);
export const SafeAreaProvider = ({ children, ...props }) => createElement(View, props, children);
export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
