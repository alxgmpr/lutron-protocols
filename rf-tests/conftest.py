"""Pytest configuration and fixtures for Lutron CCA tests."""

import json
import sys
from pathlib import Path

import pytest

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))


@pytest.fixture(scope="session")
def fixtures_path():
    """Path to test fixtures directory."""
    return Path(__file__).parent.parent / "test_fixtures"


@pytest.fixture(scope="session")
def packet_fixtures(fixtures_path):
    """Load packet test fixtures from JSON file."""
    fixtures_file = fixtures_path / "packets.json"
    with open(fixtures_file) as f:
        data = json.load(f)
    return data["packets"]


@pytest.fixture(scope="session")
def fixtures_metadata(fixtures_path):
    """Load full fixtures file including metadata."""
    fixtures_file = fixtures_path / "packets.json"
    with open(fixtures_file) as f:
        return json.load(f)


def get_fixture_by_id(packet_fixtures, fixture_id):
    """Helper to find fixture by ID."""
    for fixture in packet_fixtures:
        if fixture["id"] == fixture_id:
            return fixture
    raise ValueError(f"Fixture not found: {fixture_id}")


@pytest.fixture
def fixture_lookup(packet_fixtures):
    """Returns a function to look up fixtures by ID."""
    def lookup(fixture_id):
        return get_fixture_by_id(packet_fixtures, fixture_id)
    return lookup
