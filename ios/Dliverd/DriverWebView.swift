import LocalAuthentication
import SwiftUI
import WebKit

struct DriverWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(context.coordinator, name: "custode")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 12 / 255, green: 18 / 255, blue: 17 / 255, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.alwaysBounceVertical = false
        webView.allowsBackForwardNavigationGestures = true
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }

        loadDriver(in: webView)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "custode")
    }

    private func loadDriver(in webView: WKWebView) {
        let bundle = Bundle.main
        let file = bundle.url(forResource: "index", withExtension: "html", subdirectory: "www")
            ?? bundle.url(forResource: "index", withExtension: "html")
        guard var url = file else { return }
        if var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            comps.queryItems = [URLQueryItem(name: "native", value: "1")]
            url = comps.url ?? url
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "custode",
                  let body = message.body as? [String: Any],
                  let action = body["action"] as? String,
                  action == "faceId" else { return }
            authenticate { [weak self] ok in
                DispatchQueue.main.async {
                    let flag = ok ? "true" : "false"
                    self?.webView?.evaluateJavaScript("window.__custodeFaceCb && window.__custodeFaceCb(\(flag))", completionHandler: nil)
                }
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            let scheme = url.scheme?.lowercased() ?? ""
            if ["tel", "sms", "mailto"].contains(scheme) || (scheme == "https" || scheme == "http") && navigationAction.navigationType == .linkActivated {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        private func authenticate(completion: @escaping (Bool) -> Void) {
            let ctx = LAContext()
            var error: NSError?
            let policy: LAPolicy = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
                ? .deviceOwnerAuthenticationWithBiometrics
                : .deviceOwnerAuthentication
            guard ctx.canEvaluatePolicy(policy, error: &error) else {
                completion(false)
                return
            }
            ctx.evaluatePolicy(policy, localizedReason: "Unlock Dliverd") { success, _ in
                completion(success)
            }
        }
    }
}
