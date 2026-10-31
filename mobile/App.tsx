import { NavigationContainer, DarkTheme, useNavigationContainerRef, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';

import { colors } from './src/theme';
import type { RootStackParamList, TabParamList } from './src/navigation';
import HomeScreen from './src/screens/HomeScreen';
import SearchScreen from './src/screens/SearchScreen';
import MyListScreen from './src/screens/MyListScreen';
import AccountScreen from './src/screens/AccountScreen';
import TitleScreen from './src/screens/TitleScreen';
import PlayerScreen from './src/screens/PlayerScreen';
import PersonScreen from './src/screens/PersonScreen';
import AuthScreen from './src/screens/AuthScreen';
import { AdMobProvider, useAdMob } from './src/ads/AdMobProvider';

/**
 * Lumora native app shell.
 *
 * Bottom tabs for the four primary destinations (Home / Search / My List /
 * Account) with a root stack pushed over them for Title, Player, Person and
 * Auth. The theme mirrors the web app's dark palette so both clients feel like
 * the same product.
 */
const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabParamList>();

const navTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.base,
    card: colors.surface,
    text: colors.content,
    border: colors.border,
    primary: colors.primary,
  },
};

/** Simple glyph tabs (no icon dependency needed). */
const tabIcon = (glyph: string) => function TabIcon({ color }: { color: string }) { return (
  <Text style={{ color, fontSize: 18 }}>{glyph}</Text>
); };

function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.contentSubtle,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
      }}
    >
      <Tabs.Screen name="Home" component={HomeScreen} options={{ tabBarIcon: tabIcon('⌂') }} />
      <Tabs.Screen name="Search" component={SearchScreen} options={{ tabBarIcon: tabIcon('⌕') }} />
      <Tabs.Screen name="MyList" component={MyListScreen} options={{ tabBarIcon: tabIcon('★'), title: 'My List' }} />
      <Tabs.Screen name="Account" component={AccountScreen} options={{ tabBarIcon: tabIcon('☺') }} />
    </Tabs.Navigator>
  );
}

function AppNavigation() {
  const navigationRef = useNavigationContainerRef<RootStackParamList>();
  const ads = useAdMob();
  function syncNavigation() {
    if (!navigationRef.isReady()) return;
    const state = navigationRef.getRootState();
    if (!state) return;
    const root = state.routes[state.index];
    if (!root) return;
    const tabState = root.state;
    ads.navigation({ root: root.name, key: root.key,
      ...(root.name === 'Tabs' ? { tab: tabState?.routes[tabState.index ?? 0]?.name ?? 'Home' } : {}) });
  }
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => subscription.remove();
  }, []);
  // The app is portrait-first; the PLAYER unlocks rotation for itself (see
  // PlayerScreen) and restores portrait on exit.
  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer ref={navigationRef} theme={navTheme} onReady={syncNavigation} onStateChange={syncNavigation}>
        <Stack.Navigator
          screenListeners={({ route }) => ({ blur: () => ads.blur(route.key), transitionEnd: ({ data }) => {
            if (route.name === 'Title' && data.closing) requestAnimationFrame(() => ads.browsingComplete());
          } })}
          screenOptions={{
            headerStyle: { backgroundColor: colors.base },
            headerTintColor: colors.content,
            contentStyle: { backgroundColor: colors.base },
            animation: reduceMotion ? 'none' : 'default',
          }}
        >
          <Stack.Screen name="Tabs" component={MainTabs} options={{ headerShown: false }} />
          <Stack.Screen name="Title" component={TitleScreen} options={{ title: '' }} />
          <Stack.Screen name="Player" component={PlayerScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Person" component={PersonScreen} options={{ title: '' }} />
          <Stack.Screen name="Auth" component={AuthScreen} options={{ title: 'Sign in' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

export default function App() {
  return <AdMobProvider><AppNavigation /></AdMobProvider>;
}
