//! CCA - Lutron Clear Connect Type A Protocol Tool
//!
//! A CLI for decoding, analyzing, and working with Lutron CCA packets.

use clap::{Parser, Subcommand};
use std::io::{self, BufReader};
use std::path::PathBuf;

use cca::codegen;
use cca::crc;
use cca::decode::{decode_log_file, summarize_log, LogEntry};
use cca::live::LiveStream;
use cca::packet::PacketParser;

#[derive(Parser)]
#[command(name = "cca")]
#[command(about = "Lutron Clear Connect Type A protocol tool", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Decode packets from file or hex string
    Decode {
        /// File path (.log for ESPHome logs) or hex string
        input: String,

        /// Output as JSON
        #[arg(short, long)]
        json: bool,

        /// Show raw bytes
        #[arg(short, long)]
        raw: bool,

        /// Show summary statistics
        #[arg(short, long)]
        summary: bool,
    },

    /// Live packet stream from ESP32
    Live {
        /// ESP32 host IP (default: 10.1.4.59)
        #[arg(short = 'H', long, default_value = "10.1.4.59")]
        host: String,

        /// Output as JSON (one object per line)
        #[arg(short, long)]
        json: bool,

        /// Show raw bytes
        #[arg(short, long)]
        raw: bool,
    },

    /// Calculate CRC-16 for hex data
    Crc {
        /// Hex string (e.g., "88008DE695052104030002...")
        hex: String,
    },

    /// Show protocol information
    Info,

    /// Generate protocol code from YAML definition
    Codegen {
        /// Protocol YAML file
        #[arg(short, long, default_value = "protocol/cca.yaml")]
        input: PathBuf,

        /// Output directory
        #[arg(short, long, default_value = "protocol/generated")]
        output: PathBuf,

        /// Target languages (comma-separated: rust,ts,md)
        #[arg(short, long)]
        targets: Option<String>,

        /// Check if files are up-to-date (for CI)
        #[arg(long)]
        check: bool,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Decode {
            input,
            json,
            raw,
            summary,
        } => {
            decode_command(&input, json, raw, summary);
        }
        Commands::Live { host, json, raw } => {
            live_command(&host, json, raw);
        }
        Commands::Crc { hex } => {
            crc_command(&hex);
        }
        Commands::Info => {
            info_command();
        }
        Commands::Codegen {
            input,
            output,
            targets,
            check,
        } => {
            codegen_command(&input, &output, targets.as_deref(), check);
        }
    }
}

fn live_command(host: &str, json: bool, show_raw: bool) {
    use std::process::{Command, Stdio};

    let stream = LiveStream::new();
    let stdout = io::stdout();
    let mut output = stdout.lock();

    eprintln!("Connecting to ESP32 at {}...", host);

    // Spawn python esp32_controller.py logs --host <ip>
    let controller_path = std::env::var("CCA_CONTROLLER").unwrap_or_else(|_| {
        // Try to find it relative to the crate
        let paths = [
            "rf/esp32_controller.py",
            "../rf/esp32_controller.py",
            "../../rf/esp32_controller.py",
            "~/lutron-tools/rf/esp32_controller.py",
        ];
        for p in paths {
            if std::path::Path::new(p).exists() {
                return p.to_string();
            }
        }
        "esp32_controller.py".to_string()
    });

    match Command::new("python3")
        .args([&controller_path, "logs", "--host", host])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(mut child) => {
            if let Some(child_stdout) = child.stdout.take() {
                let reader = BufReader::new(child_stdout);
                if let Err(e) = stream.stream_from_reader(reader, &mut output, json, show_raw) {
                    eprintln!("Error reading stream: {}", e);
                }
            }
            let _ = child.wait();
        }
        Err(e) => {
            eprintln!("Failed to start esp32_controller.py: {}", e);
            eprintln!("Make sure python3 and aioesphomeapi are installed");
            eprintln!("Set CCA_CONTROLLER env var to override path");
            std::process::exit(1);
        }
    }
}

fn decode_command(input: &str, json: bool, show_raw: bool, show_summary: bool) {
    let path = PathBuf::from(input);

    if path.exists() {
        // File input
        if path.extension().map(|e| e == "log").unwrap_or(false) {
            // ESPHome log file
            match decode_log_file(&path) {
                Ok(entries) => {
                    if show_summary {
                        let summary = summarize_log(&entries);
                        println!("Log Summary:");
                        println!("  Total packets: {}", summary.total_packets);
                        println!("  Valid CRC: {}", summary.valid_crc);
                        println!("  Invalid CRC: {}", summary.invalid_crc);
                        println!("\nPacket Types:");
                        let mut types: Vec<_> = summary.packet_types.iter().collect();
                        types.sort_by(|a, b| b.1.cmp(a.1));
                        for (ptype, count) in types {
                            println!("  {}: {}", ptype, count);
                        }
                        println!("\nDevices:");
                        let mut devices: Vec<_> = summary.devices.iter().collect();
                        devices.sort_by(|a, b| b.1.cmp(a.1));
                        for (device, count) in devices {
                            println!("  {}: {}", device, count);
                        }
                    } else if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(
                                &entries
                                    .iter()
                                    .map(|e| {
                                        serde_json::json!({
                                            "timestamp": e.timestamp,
                                            "type": e.packet_type,
                                            "device_id": e.device_id,
                                            "target_id": e.target_id,
                                            "level": e.level,
                                            "sequence": e.sequence,
                                            "rssi": e.rssi,
                                            "crc_ok": e.crc_ok,
                                        })
                                    })
                                    .collect::<Vec<_>>()
                            )
                            .unwrap()
                        );
                    } else {
                        for entry in &entries {
                            print_log_entry(entry, show_raw);
                        }
                        println!("\nTotal: {} packets", entries.len());
                    }
                }
                Err(e) => {
                    eprintln!("Error reading log file: {}", e);
                    std::process::exit(1);
                }
            }
        } else {
            eprintln!("Unsupported file type. Use .log for ESPHome logs.");
            std::process::exit(1);
        }
    } else {
        // Hex string input
        let hex_clean: String = input.chars().filter(|c| c.is_ascii_hexdigit()).collect();

        match hex::decode(&hex_clean) {
            Ok(bytes) => {
                let parser = PacketParser::new();
                match parser.parse_bytes(&bytes) {
                    Some(packet) => {
                        if json {
                            println!("{}", serde_json::to_string_pretty(&packet).unwrap());
                        } else {
                            print_packet(&packet, show_raw);
                        }
                    }
                    None => {
                        eprintln!("Failed to parse packet");
                        std::process::exit(1);
                    }
                }
            }
            Err(e) => {
                eprintln!("Invalid hex string: {}", e);
                std::process::exit(1);
            }
        }
    }
}

fn print_log_entry(entry: &LogEntry, show_raw: bool) {
    let crc_status = if entry.crc_ok { "OK" } else { "BAD" };

    print!(
        "[{}] {} | {} ",
        entry.timestamp, entry.packet_type, entry.device_id
    );

    if let Some(ref target) = entry.target_id {
        print!("-> {} ", target);
    }

    if let Some(level) = entry.level {
        print!("| Level={}% ", level);
    }

    println!(
        "| Seq={} | RSSI={} | CRC={}",
        entry.sequence, entry.rssi, crc_status
    );

    if show_raw {
        println!("  Raw: {}", entry.raw_line);
    }
}

fn print_packet(packet: &cca::DecodedPacket, show_raw: bool) {
    let crc_status = if packet.crc_valid { "OK" } else { "BAD" };

    println!(
        "Type: {} (0x{:02X})",
        packet.packet_type.name(),
        packet.type_byte
    );
    println!("Device ID: {}", packet.device_id_str());
    println!("Sequence: {}", packet.sequence);

    if let Some(btn) = &packet.button {
        println!("Button: {}", btn.name());
    }
    if let Some(action) = &packet.action {
        println!("Action: {}", action.name());
    }
    if let Some(level) = packet.level {
        println!("Level: {}%", level);
    }
    if let Some(target) = packet.target_id_str() {
        println!("Target ID: {}", target);
    }
    if let Some(fmt) = packet.format_byte {
        println!("Format: 0x{:02X}", fmt);
    }

    println!("CRC: 0x{:04X} ({})", packet.crc, crc_status);

    if show_raw {
        let hex_str: String = packet
            .raw
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(" ");
        println!("Raw: {}", hex_str);
    }
}

fn crc_command(hex: &str) {
    let hex_clean: String = hex.chars().filter(|c| c.is_ascii_hexdigit()).collect();

    match hex::decode(&hex_clean) {
        Ok(bytes) => {
            let crc = crc::calc_crc(&bytes);
            println!("CRC-16: 0x{:04X}", crc);
            println!("Bytes: {:02X} {:02X}", (crc >> 8) as u8, (crc & 0xFF) as u8);
        }
        Err(e) => {
            eprintln!("Invalid hex string: {}", e);
            std::process::exit(1);
        }
    }
}

fn info_command() {
    println!("Lutron Clear Connect Type A (CCA) Protocol");
    println!();
    println!("RF Parameters:");
    println!("  Frequency: 433.602844 MHz");
    println!("  Modulation: 2-FSK");
    println!("  Data Rate: 62.5 kBaud");
    println!("  Deviation: 41.2 kHz");
    println!();
    println!("Packet Types:");
    println!("  0x88-0x8B: Button press (24 bytes)");
    println!("  0x81-0x83: State report (24 bytes)");
    println!("  0xA2-0xA3: Level/config (24 bytes)");
    println!("  0x91-0x92: Beacon (24 bytes)");
    println!("  0xB8-0xBB: Pairing (53 bytes)");
    println!("  0xC0-0xC8: Pairing response (24 bytes)");
    println!();
    println!("CRC: Polynomial 0xCA0F (non-standard)");
    println!("Encoding: N81 (start=0, 8 data LSB-first, stop=1)");
}

fn codegen_command(input: &PathBuf, output: &PathBuf, targets_str: Option<&str>, check: bool) {
    // Parse target list
    let targets: Vec<codegen::Target> = match targets_str {
        Some(s) => s
            .split(',')
            .filter_map(|t| codegen::Target::from_str(t.trim()))
            .collect(),
        None => codegen::Target::all().to_vec(),
    };

    if targets.is_empty() {
        eprintln!("No valid targets specified");
        eprintln!("Valid targets: rust, ts, md");
        std::process::exit(1);
    }

    // Load protocol definition
    let protocol = match codegen::load_protocol(input) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Failed to load protocol file '{}': {}", input.display(), e);
            std::process::exit(1);
        }
    };

    if check {
        // Check mode - verify files are up-to-date
        match codegen::check(&protocol, output, &targets) {
            Ok(true) => {
                println!("All generated files are up-to-date");
            }
            Ok(false) => {
                eprintln!("Generated files are out of date. Run 'cca codegen' to regenerate.");
                std::process::exit(1);
            }
            Err(e) => {
                eprintln!("Check failed: {}", e);
                std::process::exit(1);
            }
        }
    } else {
        // Generate mode
        match codegen::generate(&protocol, output, &targets) {
            Ok(()) => {
                println!("Generated files:");
                for target in &targets {
                    let target_dir = output.join(target.output_dir());
                    let filename = match target {
                        codegen::Target::Rust => "mod.rs",
                        codegen::Target::TypeScript => "protocol.ts",
                        codegen::Target::Markdown => "PROTOCOL.md",
                    };
                    println!("  {}", target_dir.join(filename).display());
                }
            }
            Err(e) => {
                eprintln!("Code generation failed: {}", e);
                std::process::exit(1);
            }
        }
    }
}
