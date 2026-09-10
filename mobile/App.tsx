import { NavigationContainer, DarkTheme, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native';

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
const tabIcon = (glyph: string) => ({ color }: { color: string }) => (
  <Text style={{ color, fontSize: 18 }}>{glyph}</Text>
);

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

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: colors.base },
            headerTintColor: colors.content,
            contentStyle: { backgroundColor: colors.base },
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
