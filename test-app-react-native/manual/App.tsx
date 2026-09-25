import { useEffect, useState } from 'react'
import { Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native'
import buildInfo from './build-info.json'
import { type Report, runChecks } from './checks'

const runtime = {
  hermes: typeof (globalThis as typeof globalThis & { HermesInternal?: unknown }).HermesInternal !== 'undefined',
  platform: Platform.OS,
}
const mode = process.env.EXPO_PUBLIC_CORE_RESOLUTION || 'legacy-cjs'
const packageVersion = require('@datadog/flagging-core/package.json').version

export default function App() {
  const [report, setReport] = useState<Report | null>(null)
  useEffect(() => {
    setReport(runChecks(runtime))
  }, [])

  const passed = report?.results.filter((result) => result.passed).length ?? 0
  const success = !!report && passed === report.results.length

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <StatusBar barStyle="light-content" />
      <Text style={styles.eyebrow}>LOCAL TARBALL / NATIVE RUNTIME</Text>
      <Text style={styles.title}>Flagging Core</Text>
      <Text style={styles.subtitle}>PR #402 manual runtime check</Text>

      <View style={styles.card}>
        <Text style={styles.heading}>Runtime and package</Text>
        <Text selectable style={styles.detail}>
          Engine: {runtime.hermes ? 'Hermes' : 'NOT HERMES'} / {runtime.platform}
          {'\n'}Metro: {mode}
          {'\n'}Core: {packageVersion}
          {'\n'}Commit: {buildInfo.commit}
          {buildInfo.dirty ? ' + local changes' : ''}
          {'\n'}Packed: {buildInfo.packedAt}
          {'\n'}Tarball SHA-256: {buildInfo.sha256.slice(0, 16)}…{'\n'}TextEncoder: {typeof globalThis.TextEncoder} /
          TextDecoder: {typeof globalThis.TextDecoder}
          {'\n'}BigInt: {typeof globalThis.BigInt}
        </Text>
      </View>

      <View style={[styles.card, success ? styles.passBorder : styles.failBorder]}>
        <Text accessibilityRole="header" style={[styles.heading, success ? styles.pass : styles.fail]}>
          {!report ? 'RUNNING…' : success ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}
        </Text>
        {report && (
          <Text style={styles.detail}>
            {passed}/{report.results.length} passed in {report.elapsedMs.toFixed(1)} ms
          </Text>
        )}
        <Pressable accessibilityRole="button" style={styles.button} onPress={() => setReport(runChecks(runtime))}>
          <Text style={styles.buttonText}>Run checks again</Text>
        </Pressable>
      </View>

      {report?.results.map((result) => (
        <View key={result.name} style={styles.card}>
          <Text style={[styles.heading, result.passed ? styles.pass : styles.fail]}>
            {result.passed ? 'PASS' : 'FAIL'} · {result.name}
          </Text>
          <Text selectable style={styles.detail}>
            {result.detail}
          </Text>
        </View>
      ))}

      <Text style={styles.detail}>
        No Datadog credentials or network requests are needed for evaluation. These checks use the runtime's real
        globals; the automated Metro smoke test separately exercises missing-global fallbacks.
        {'\n\n'}To change resolution mode, stop Metro and use npm run start:modern or npm run start:legacy-esm. Check
        the Metro terminal for the actual resolved SDK paths.
        {'\n\n'}After changing SDK source, prepare a new app with yarn example:react-native from the repository. Fast
        Refresh does not rebuild the installed tarball.
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101426' },
  content: { paddingHorizontal: 20, paddingTop: 64, paddingBottom: 64, gap: 16 },
  eyebrow: { color: '#adb9e8', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  title: { color: '#ffffff', fontSize: 36, fontWeight: '800' },
  subtitle: { color: '#bdc6e6', fontSize: 16, marginBottom: 8 },
  card: { backgroundColor: '#1b223b', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#303c60', gap: 10 },
  heading: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  detail: { color: '#c6cfea', fontSize: 14, lineHeight: 21 },
  pass: { color: '#85e0b2' },
  fail: { color: '#ffaaaa' },
  passBorder: { borderColor: '#85e0b2' },
  failBorder: { borderColor: '#ffaaaa' },
  button: { backgroundColor: '#b9b6ff', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#13152c', fontSize: 16, fontWeight: '700' },
})
