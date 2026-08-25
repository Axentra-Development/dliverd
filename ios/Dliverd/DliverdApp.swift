import SwiftUI

@main
struct DliverdApp: App {
    var body: some Scene {
        WindowGroup {
            DriverWebView()
                .ignoresSafeArea()
                .preferredColorScheme(.light)
        }
    }
}
