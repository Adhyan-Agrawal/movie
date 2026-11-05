import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

interface Props { children: ReactNode }
interface State { failed: boolean }

/** Last-resort JS recovery surface. Native process failures still require device logs. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Lumora UI recovered from an unexpected error.', error, info.componentStack);
  }

  private retry = () => {
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View style={styles.root} accessibilityRole="alert">
        <Text style={styles.title}>Lumora could not open this screen</Text>
        <Text style={styles.body}>Your account, ads, and playback preferences remain unchanged. Retry to rebuild the app interface.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Retry Lumora" onPress={this.retry} style={styles.button}>
          <Text style={styles.buttonText}>Retry Lumora</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, padding: 28, backgroundColor: '#08090c' },
  title: { color: '#f4f4f7', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  body: { color: '#b8b9c3', fontSize: 15, lineHeight: 22, textAlign: 'center' },
  button: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 22, borderRadius: 12, backgroundColor: '#7c5cff' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
