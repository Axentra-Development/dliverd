import SwiftUI

@main
struct CustodeApp: App {
    var body: some Scene {
        WindowGroup {
            DriverWebView()
                .ignoresSafeArea()
                .preferredColorScheme(.light)
        }
    }
}
