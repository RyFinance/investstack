import helpers

import json
import socket
import unittest
from unittest.mock import Mock, patch

from valora import config, db, props, server
from valora.sources import custom


class SetupTests(unittest.TestCase):
    def setUp(self):
        helpers.fresh_home()
        config.save({"demo": False, "currency": "GBP"})
        with db.db(False) as conn:
            self.pid = props.upsert(conn, {"address": "10 Example Road, Leeds, United Kingdom"})
        self.provider = {
            "name": "Example data", "endpoint": "https://api.example.com/property", "address_param": "address",
            "auth": "bearer", "key": "test-primary-credential", "currency": "GBP",
            "mapping": {"beds": "data.0.bedrooms", "value": "data.0.valuation"},
        }
        self.assertEqual(self.call("save", **self.provider), (200, {"ok": True}))
        self.connector = custom.public()[0]["id"]

    @staticmethod
    def call(action, **body):
        status, response = server.api_post("/api/setup/providers", {"act": action, **body})
        return status, json.loads(response)

    def test_pull_then_import_only_writes_confirmed_data(self):
        with patch.object(custom, "_request", return_value={"data": [{"bedrooms": 3, "valuation": 250000}]}):
            status, preview = self.call("preview", id=self.connector, property_id=self.pid)
        self.assertEqual(status, 200)
        self.assertEqual(preview["facts"], {"beds": 3, "value": 250000})
        with db.db(False) as conn:
            self.assertIsNone(props.get(conn, self.pid)["beds"])
        self.assertEqual(self.call("apply", token=preview["token"]), (200, {"ok": True}))
        self.assertEqual(self.call("apply", token=preview["token"])[0], 400)
        with db.db(False) as conn:
            self.assertEqual(props.get(conn, self.pid)["beds"], 3)
            self.assertEqual(props.value_est(conn, self.pid)["source"], "Custom provider · Example data")
            source = db.one(conn, "select * from property_source where property_id=?", (self.pid,))
            self.assertNotIn("test-primary-credential", source["fields"])
            self.assertEqual(json.loads(source["fields"])["currency"], "GBP")

    def test_credentials_redact_from_responses_and_never_follow_redirects(self):
        status, _ = self.call("save-credential", id=self.connector, auth="query", auth_name="tenantKey", key="test-extra-credential")
        self.assertEqual(status, 200)
        status, payload = self.call("list")
        self.assertEqual(status, 200)
        self.assertEqual(payload["providers"][0]["extra"], [{"auth": "query", "auth_name": "tenantKey"}])
        self.assertNotIn("credential", json.dumps(payload))
        self.assertNotIn("connectors_json", config.public())
        connection = Mock()
        connection.getresponse.return_value.status = 302
        with patch.object(custom, "_public_connection", return_value=connection):
            status, response = self.call("preview", id=self.connector, property_id=self.pid)
        self.assertEqual(status, 400)
        self.assertIn("HTTP 302", response["error"])
        connection.request.assert_called_once()
        self.assertIn("tenantKey=test-extra-credential", connection.request.call_args.args[1])
        self.assertEqual(connection.request.call_args.kwargs["headers"]["Authorization"], "Bearer test-primary-credential")
        connection.close.assert_called_once()

    def test_provider_estimates_omit_foreign_currency(self):
        config.save({"currency": "CAD"})
        with patch.object(custom, "_request", return_value={"data": [{"bedrooms": 3, "valuation": 250000}]}):
            status, preview = self.call("preview", id=self.connector, property_id=self.pid)
        self.assertEqual(status, 200)
        self.assertTrue(preview["currency_mismatch"])
        self.assertEqual(preview["facts"], {"beds": 3})

    def test_rejects_private_dns_results_and_secret_reuse_on_new_host(self):
        with patch.object(socket, "getaddrinfo", return_value=[
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
        ]):
            with self.assertRaisesRegex(ValueError, "public internet address"):
                custom._public_connection("api.example.com")
        status, _ = self.call("save", id=self.connector, **{
            **self.provider, "endpoint": "https://other.example.com/lookup", "key": "",
        })
        self.assertEqual(status, 400)
        self.assertEqual(custom.public()[0]["endpoint"], self.provider["endpoint"])
