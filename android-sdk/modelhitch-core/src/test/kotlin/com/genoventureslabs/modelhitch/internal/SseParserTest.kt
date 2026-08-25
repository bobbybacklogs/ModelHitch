package com.genoventureslabs.modelhitch.internal

import kotlin.test.Test
import kotlin.test.assertEquals

class SseParserTest {
    @Test
    fun `parses fragmented CRLF events and skips comments and done sentinel`() {
        val parser = SseParser()

        val events = buildList {
            addAll(parser.accept(": keep-alive\r\nda"))
            addAll(parser.accept("ta: {\"delta\":\"Hel"))
            addAll(parser.accept("lo\"}\r\n\r\ndata: first\r\ndata: second\r\n\r\n"))
            addAll(parser.accept("data: [DONE]\r\n\r\n"))
            addAll(parser.finish())
        }

        assertEquals(listOf("{\"delta\":\"Hello\"}", "first\nsecond"), events)
    }
}