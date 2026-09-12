package com.v2ray.ang.ui

import android.app.ActivityManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.TextView
import com.v2ray.ang.R
import com.v2ray.ang.dto.entities.ProfileItem
import com.v2ray.ang.extension.toast
import com.v2ray.ang.handler.MmkvManager
import com.v2ray.ang.handler.SettingsManager
import com.v2ray.ang.util.Utils
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.io.PrintWriter
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.ArrayList
import java.util.Date
import java.util.Locale
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Sonic VPN: режим отладки.
 *
 * Проверяет с телефона:
 *  T1 — прямой TCP до VPN-сервера (видит блокировку провайдером)
 *  T2 — прямой TLS до VPN-сервера с SNI профиля (Reality-ответ)
 *  T3 — DNS телефона
 *  T4/T5 — тра СКВОЗЬ туннель (SOCKS5 локального core, DNS в туннеле):
 *          youtube.com и google.com/generate_204
 *  T6 — статус сервера (проверки RU-сервером: TCP/TLS/панель)
 *  плюс: активный профиль, состояние VPN-сервиса, хвост лога xray-core.
 *
 * Отчёт копируется в буфер обмена — владелец отправляет его в поддержку.
 */
class DebugActivity : BaseActivity() {

    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var resultView: TextView
    private lateinit var runButton: Button
    private lateinit var copyButton: Button
    private var lastReport = ""

    private val trustAllTrustManager = TrustManager(
        object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
    )

    private val trustAllSocketFactory: SSLSocketFactory by lazy {
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(trustAllTrustManager), SecureRandom())
        ctx.socketFactory
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentViewWithToolbar(R.layout.activity_debug, showHomeAsUp = true, title = getString(R.string.title_debug))
        resultView = findViewById(R.id.debug_result)
        runButton = findViewById(R.id.debug_run)
        copyButton = findViewById(R.id.debug_copy)
        runButton.setOnClickListener { startChecks() }
        copyButton.setOnClickListener {
            if (lastReport.isNotEmpty()) {
                Utils.setClipboard(this, lastReport)
                toast(getString(R.string.debug_report_copied))
            }
        }
        startChecks()
    }

    private fun startChecks() {
        runButton.isEnabled = false
        copyButton.isEnabled = false
        resultView.text = getString(R.string.debug_running)
        Thread {
            val report = runChecksSafe()
            mainHandler.post {
                lastReport = report
                resultView.text = report
                runButton.isEnabled = true
                copyButton.isEnabled = true
            }
        }.start()
    }

    // ---------- отчёт ----------

    private fun runChecksSafe(): String {
        val sb = StringBuilder()
        sb.append("SONIC-APK-DEBUG ")
            .append(SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date()))
            .append("\n")
        try {
            val pInfo = packageManager.getPackageInfo(packageName, 0)
            sb.append("app: ")
                .append(pInfo.versionName ?: "unknown")
                .append(" / Android ")
                .append(Build.VERSION.RELEASE)
                .append(" (api ").append(Build.VERSION.SDK_INT).append(")\n")
        } catch (e: Exception) {
            sb.append("app: n/a\n")
        }
        sb.append("mode: ").append(if (SettingsManager.isVpnMode()) "VPN (TUN)" else "per-app").append("\n")
        sb.append("vpn-service: ").append(serviceState()).append("\n")

        val guid = MmkvManager.getSelectServer() ?: ""
        val profile: ProfileItem? = try {
            MmkvManager.decodeServerConfig(guid)
        } catch (e: Exception) {
            null
        }

        var host: String? = null
        var port: Int? = null
        if (profile != null) {
            host = profile.server
            port = profile.serverPort?.toIntOrNull()
            sb.append("profile: ")
                .append(profile.remarks.ifEmpty { "(без названия)" })
                .append(" | type=").append(profile.configType.name.lowercase(Locale.US))
                .append(" server=").append(profile.server).append(":").append(profile.serverPort)
                .append(" security=").append(profile.security)
                .append(" sni=").append(profile.sni)
                .append(" pbk=").append(profile.publicKey)
                .append(" sid=").append(profile.shortId)
                .append(" flow=").append(profile.flow)
                .append("\n")
            sb.append("uuid: ").append(profile.password).append("\n")
        } else {
            sb.append("profile: НЕ ВЫБРАН — в приложении не выбран сервер\n")
        }

        var t1 = "skipped (нет профиля)"
        var t2 = "skipped (нет профиля)"
        var t4 = "skipped (нет профиля)"
        var t5 = "skipped (нет профиля)"
        if (host != null && port != null) {
            t1 = testTcp(host, port, 8000)
            t2 = testTls(host, port, profile?.sni, 10000)
            t4 = httpsGetViaSocks("www.youtube.com", 443, "/", 12000)
            t5 = httpsGetViaSocks("www.google.com", 443, "/generate_204", 10000)
        }
        val t3 = testDns("www.youtube.com")
        val t6 = testSiteStatus()
        val log = logTail()

        sb.append("T1 direct-tcp ").append(host ?: "n/a").append(":").append(port ?: "n/a").append(": ").append(t1).append("\n")
        sb.append("T2 direct-tls (sni=").append(profile?.sni ?: host ?: "n/a").append("): ").append(t2).append("\n")
        sb.append("T3 dns-phone youtube.com: ").append(t3).append("\n")
        sb.append("T4 tunnel->www.youtube.com (dns via tunnel): ").append(t4).append("\n")
        sb.append("T5 tunnel->google/generate_204: ").append(t5).append("\n")
        sb.append("T6 site-status (RU server): ").append(t6).append("\n")
        sb.append("xray-core-log-tail:\n").append(log).append("\n")
        sb.append("verdict:\n").append(verdict(t1, t2, t4, t5)).append("\n")
        return sb.toString()
    }

    private fun verdict(t1: String, t2: String, t4: String, t5: String): String {
        val v = ArrayList<String>()
        val tunnelOk = t4.startsWith("OK") || t5.startsWith("OK")
        val directOk = t1.startsWith("OK")
        if (tunnelOk) {
            v.add("Туннель работает: сайты через VPN грузятся. Если в браузере всё равно не грузится — проверьте, что VPN включён и браузер не использует обход (per-app).")
        } else if (directOk && t2.startsWith("OK")) {
            v.add("Сервер из вашей сети достижим, но туннель НЕ работает: VPN не включён в приложении, профиль не соответствует серверу, или включён per-app режим.")
        } else if (t1.startsWith("FAIL") && t1.contains("timeout")) {
            v.add("СЕРВЕР НЕДОСТИЖИМ ИЗ ВАШЕЙ СЕТИ (таймаут прямого подключения): оператор/сеть блокирует или роняет пакеты до VPN-сервера.")
        } else if (t1.startsWith("FAIL")) {
            v.add("Прямое подключение к серверу упало: " + t1)
        } else {
            v.add("Проверки не дали однозначного ответа — отправьте отчёт в поддержку.")
        }
        return v.joinToString("\n") { "  " + it }
    }

    // ---------- проверки ----------

    private fun serviceState(): String {
        return try {
            val am = getSystemService(ACTIVITY_SERVICE) as ActivityManager
            val running = am.getRunningServices(Int.MAX_VALUE)
                .map { it.service.className }
                .filter {
                    it.contains("CoreVpnService") ||
                        it.contains("CoreProxyOnlyService") ||
                        it.contains("CoreRootService")
                }
                .map { it.substringAfterLast('.') }
            if (running.isEmpty()) "not running (VPN выключен в приложении)"
            else "running: " + running.joinToString(", ")
        } catch (e: Exception) {
            "n/a"
        }
    }

    private fun classify(e: Exception): String {
        if (e is SocketTimeoutException) return "timeout"
        val m = e.message ?: e.javaClass.simpleName
        return when {
            m.contains("refused", true) -> "connection refused"
            m.contains("unreachable", true) -> "unreachable"
            m.contains("reset", true) -> "connection reset"
            else -> m.take(80)
        }
    }

    private fun testTcp(host: String, port: Int, timeoutMs: Int): String {
        val t0 = System.currentTimeMillis()
        val s = Socket()
        try {
            s.connect(InetSocketAddress(host, port), timeoutMs)
            return "OK ${System.currentTimeMillis() - t0}ms"
        } catch (e: Exception) {
            return "FAIL ${classify(e)} (${System.currentTimeMillis() - t0}ms)"
        } finally {
            try {
                s.close()
            } catch (ignored: Exception) {
            }
        }
    }

    private fun testTls(host: String, port: Int, sni: String?, timeoutMs: Int): String {
        val t0 = System.currentTimeMillis()
        val s = Socket()
        try {
            s.connect(InetSocketAddress(host, port), timeoutMs)
            val tls = trustAllSocketFactory.createSocket(s, host, port, true) as SSLSocket
            val params = tls.sslParameters
            val sniName = if (sni.isNullOrEmpty()) host else sni
            if (sniName.isNotEmpty()) {
                val names = ArrayList<SNIHostName>()
                names.add(SNIHostName(sniName))
                params.serverNames = names
            }
            tls.sslParameters = params
            tls.soTimeout = timeoutMs
            tls.startHandshake()
            return "OK ${System.currentTimeMillis() - t0}ms (${tls.session.cipherSuite})"
        } catch (e: Exception) {
            return "FAIL ${classify(e)} (${System.currentTimeMillis() - t0}ms)"
        } finally {
            try {
                s.close()
            } catch (ignored: Exception) {
            }
        }
    }

    private fun testDns(domain: String): String {
        val t0 = System.currentTimeMillis()
        try {
            val addr = InetAddress.getByName(domain)
            return "OK ${addr.hostAddress} ${System.currentTimeMillis() - t0}ms"
        } catch (e: Exception) {
            return "FAIL ${classify(e)} (${System.currentTimeMillis() - t0}ms)"
        }
    }

    /** Минимальный SOCKS5-клиент: подключение через локальный core (туннель), DNS — в туннеле. */
    private fun socks5Tunnel(domain: String, port: Int, timeoutMs: Int): Socket {
        val socksPort = SettingsManager.getSocksPort()
        val s = Socket()
        s.connect(InetSocketAddress("127.0.0.1", socksPort), timeoutMs)
        s.soTimeout = timeoutMs
        val out = s.getOutputStream()
        val inp = s.getInputStream()
        out.write(byteArrayOf(0x05, 0x01, 0x00))
        out.flush()
        val r1 = readFully(inp, 2)
        if (r1[0].toInt() != 0x05) throw IOException("not socks5: " + r1[0].toInt())
        if (r1[1].toInt() != 0x00) throw IOException("socks method rejected: " + r1[1].toInt())
        val domainBytes = domain.toByteArray(Charsets.UTF_8)
        if (domainBytes.size > 255) throw IOException("domain too long")
        val req = ByteArrayOutputStream()
        req.write(0x05)
        req.write(0x01)
        req.write(0x00)
        req.write(0x03)
        req.write(domainBytes.size)
        req.write(domainBytes)
        req.write((port shr 8) and 0xFF)
        req.write(port and 0xFF)
        out.write(req.toByteArray())
        out.flush()
        val r2 = readFully(inp, 4)
        if (r2[1].toInt() != 0x00) throw IOException("socks connect reply: " + r2[1].toInt())
        when (r2[3].toInt()) {
            1 -> readFully(inp, 6)
            4 -> readFully(inp, 18)
            3 -> {
                val len = inp.read()
                if (len < 0) throw IOException("socks short reply")
                readFully(inp, len + 2)
            }
            else -> throw IOException("socks unknown atyp: " + r2[3].toInt())
        }
        return s
    }

    private fun readFully(inp: InputStream, n: Int): ByteArray {
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = inp.read(buf, off, n - off)
            if (r < 0) throw IOException("connection closed")
            off += r
        }
        return buf
    }

    /** HTTPS GET через туннель (SOCKS5 + TLS поверх). Возвращает HTTP-статус. */
    private fun httpsGetViaSocks(domain: String, port: Int, path: String, timeoutMs: Int): String {
        val t0 = System.currentTimeMillis()
        val raw = try {
            socks5Tunnel(domain, port, timeoutMs)
        } catch (e: Exception) {
            return "FAIL ${classify(e)} (${System.currentTimeMillis() - t0}ms)"
        }
        try {
            val tls = trustAllSocketFactory.createSocket(raw, domain, port, true) as SSLSocket
            tls.soTimeout = timeoutMs
            tls.startHandshake()
            val writer = PrintWriter(OutputStreamWriter(tls.getOutputStream(), Charsets.UTF_8), false)
            writer.print("GET $path HTTP/1.1\r\nHost: $domain\r\nUser-Agent: SonicVPN-Debug\r\nConnection: close\r\n\r\n")
            writer.flush()
            val reader = InputStreamReader(tls.getInputStream(), Charsets.UTF_8)
            val line = reader.readLine() ?: ""
            val ms = System.currentTimeMillis() - t0
            if (line.startsWith("HTTP/")) {
                val status = line.substringAfter(" ", "").substringBefore(" ")
                return "OK $status ${ms}ms"
            }
            return "FAIL " + line.take(80) + " (${ms}ms)"
        } catch (e: Exception) {
            return "FAIL ${classify(e)} (${System.currentTimeMillis() - t0}ms)"
        } finally {
            try {
                raw.close()
            } catch (ignored: Exception) {
            }
        }
    }

    /** Статус сервера: запрос к публичному эндпоинту RU-сайта (проверки сервер сам себя). */
    private fun testSiteStatus(): String {
        val bases = listOf("http://87.249.49.204", "https://87.249.49.204")
        for (base in bases) {
            val conn: java.net.HttpURLConnection = try {
                val url = URL("$base/api/debug/server")
                val c = url.openConnection() as java.net.HttpURLConnection
                if (c is HttpsURLConnection) {
                    c.sslSocketFactory = trustAllSocketFactory
                    c.hostnameVerifier = HostnameVerifier { _, _ -> true }
                }
                c.connectTimeout = 8000
                c.readTimeout = 8000
                c.requestMethod = "GET"
                c
            } catch (e: Exception) {
                continue
            }
            try {
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val body = if (stream != null) InputStreamReader(stream, Charsets.UTF_8).use { it.readText() } else ""
                conn.disconnect()
                return "OK http=$code " + body.take(220)
            } catch (e: Exception) {
                try {
                    conn.disconnect()
                } catch (ignored: Exception) {
                }
            }
        }
        return "n/a (сайт недоступен с телефона)"
    }

    /** Хвост лога xray-core из системного logcat (тег GoLog). */
    private fun logTail(): String {
        return try {
            val process = Runtime.getRuntime().exec(arrayOf("logcat", "-d", "-s", "GoLog"))
            val lines = InputStreamReader(process.inputStream, Charsets.UTF_8).use { it.readLines() }
            val tail = lines.takeLast(12).joinToString("\n") { "  " + it }
            if (tail.isBlank()) "  (пусто)" else tail
        } catch (e: Exception) {
            "  n/a"
        }
    }
}
