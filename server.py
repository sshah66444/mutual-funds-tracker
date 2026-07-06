import http.server
import socketserver
import webbrowser
import threading
import time
import os
import subprocess

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

def open_browser():
    time.sleep(1.5)  # Wait for the server to spin up
    print(f"Opening web browser... navigate to http://localhost:{PORT}")
    webbrowser.open(f"http://localhost:{PORT}")

def update_data_periodically():
    while True:
        try:
            print("\n[Auto-Updater] Checking for mutual fund database updates...")
            # Run the scraper script in a subprocess
            result = subprocess.run(
                ["python3", "mufap_data_collector.py"],
                capture_output=True, text=True, check=True
            )
            print("[Auto-Updater] Scraper executed successfully. Mutual fund directory updated.")
        except Exception as e:
            print(f"[Auto-Updater] Automatic background update failed: {e}")
        
        # Sleep for 24 hours before next check
        time.sleep(24 * 3600)

def main():
    # Change working directory to ensure correct resolution of relative files
    os.chdir(DIRECTORY)
    
    # Run simple server
    handler = Handler
    
    # Allow address reuse
    socketserver.TCPServer.allow_reuse_address = True
    
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        print(f"Starting server on port {PORT}...")
        print(f"Serving files from: {DIRECTORY}")
        
        # Start browser in a separate thread so it doesn't block server startup
        browser_thread = threading.Thread(target=open_browser)
        browser_thread.daemon = True
        browser_thread.start()
        
        # Start background auto-updater thread (runs immediately, then every 24 hours)
        updater_thread = threading.Thread(target=update_data_periodically)
        updater_thread.daemon = True
        updater_thread.start()
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")

if __name__ == "__main__":
    main()
