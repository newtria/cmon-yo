import XCTest
@testable import CmonYo

final class NativeSafetyTests: XCTestCase {
  @MainActor
  func testFailedCredentialDeletionCannotRestoreAfterRecreation() async throws {
    let suite = "CmonYo-session-test-" + UUID().uuidString
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let storage = FailingSessionStorage(token: "old-token")
    storage.failDelete = true
    let origin = URL(string: "https://example.test")!
    let vault = SessionVault(origin: origin.absoluteString, storage: storage, defaults: defaults)
    XCTAssertThrowsError(try vault.save(nil))
    XCTAssertEqual(storage.token, "old-token")

    let reopened = SessionVault(origin: origin.absoluteString, storage: storage,
      defaults: try XCTUnwrap(UserDefaults(suiteName: suite)))
    let session = AccountSession(baseURL: origin, credentialStore: reopened)
    await session.restore()
    try await session.refreshAccount()
    XCTAssertNil(session.user)
    XCTAssertEqual(storage.reads, 0)

    storage.failSave = true
    XCTAssertThrowsError(try reopened.save("new-token"))
    XCTAssertNil(try reopened.read())
    storage.failSave = false
    try reopened.save("new-token")
    XCTAssertEqual(try reopened.read(), "new-token")
    XCTAssertEqual(storage.reads, 1)
  }

  func testLogoutMarkerIsScopedToItsOriginAndReadFailuresDoNotBlockRetry() throws {
    let suite = "CmonYo-session-test-" + UUID().uuidString
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let storage = FailingSessionStorage(token: "other-token")
    let signedOut = SessionVault(origin: "https://first.example.test", storage: storage, defaults: defaults)
    storage.failDelete = true
    XCTAssertThrowsError(try signedOut.save(nil))
    let other = SessionVault(origin: "https://other.example.test", storage: storage, defaults: defaults)
    storage.failRead = true
    XCTAssertThrowsError(try other.read())
    storage.failRead = false
    XCTAssertEqual(try other.read(), "other-token")
    XCTAssertNil(try signedOut.read())
  }

  func testReleaseRequiresHTTPSOriginWithoutCredentialsOrRoutingSuffix() {
    XCTAssertNil(NativeConfiguration.apiURL(environment: nil, bundled: nil, allowLocal: false))
    XCTAssertNil(NativeConfiguration.apiURL(environment: nil, bundled: "$(CMON_API_URL)", allowLocal: false))
    for raw in ["http://127.0.0.1:3000", "http://example.test", "https://user:password@example.test",
      "https://example.test/path", "https://example.test?token=secret", "https://example.test#fragment"] {
      XCTAssertNil(NativeConfiguration.apiURL(environment: nil, bundled: raw, allowLocal: false))
    }
    XCTAssertEqual(NativeConfiguration.apiURL(environment: nil, bundled: "https://example.test/", allowLocal: false)?.absoluteString,
      "https://example.test/")
    XCTAssertEqual(NativeConfiguration.apiURL(environment: nil, bundled: nil, allowLocal: true)?.absoluteString,
      "http://127.0.0.1:3000")
    XCTAssertNil(NativeConfiguration.apiURL(environment: "not-a-url", bundled: "https://example.test", allowLocal: true))
  }

  func testPendingMeetingSurvivesRecreationAndCannotCrossAccountOrOrigin() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let origin = URL(string: "https://example.test")!
    let owner = "11111111-1111-4111-8111-111111111111"
    let request = PendingMeetingMutation(key: UUID().uuidString.lowercased(), owner: owner,
      path: "api/v1/meetups", method: "POST", body: Data("{\"title\":\"저장된 모임\"}".utf8))
    try MeetingCommandStore(directory: directory).save(request, origin: origin)
    let reopened = MeetingCommandStore(directory: directory)
    let restored = try XCTUnwrap(reopened.load(owner: owner, origin: origin, path: request.path, method: "POST"))
    XCTAssertEqual(restored.key, request.key)
    XCTAssertEqual(restored.body, request.body)
    XCTAssertNil(try reopened.load(owner: "22222222-2222-4222-8222-222222222222", origin: origin, path: request.path, method: "POST"))
    XCTAssertNil(try reopened.load(owner: owner, origin: URL(string: "https://other.test")!, path: request.path, method: "POST"))
    XCTAssertThrowsError(try reopened.load(owner: owner, origin: origin, path: request.path, method: "PATCH"))
    let newer = PendingMeetingMutation(key: UUID().uuidString.lowercased(), owner: owner,
      path: request.path, method: request.method, body: request.body)
    try reopened.save(newer, origin: origin)
    try reopened.clear(request, origin: origin)
    XCTAssertEqual(try reopened.load(owner: owner, origin: origin, path: request.path, method: "POST")?.key, newer.key)
    try reopened.clear(newer, origin: origin)
    XCTAssertNil(try reopened.load(owner: owner, origin: origin, path: request.path, method: "POST"))
  }
}

private final class FailingSessionStorage: SessionCredentialStore {
  var token: String?
  var reads = 0
  var failRead = false
  var failDelete = false
  var failSave = false
  init(token: String?) { self.token = token }
  func read() throws -> String? {
    reads += 1
    if failRead { throw ProductError(status: 0, code: "KEYCHAIN") }
    return token
  }
  func save(_ token: String?) throws {
    if token == nil ? failDelete : failSave { throw ProductError(status: 0, code: "KEYCHAIN") }
    self.token = token
  }
}
