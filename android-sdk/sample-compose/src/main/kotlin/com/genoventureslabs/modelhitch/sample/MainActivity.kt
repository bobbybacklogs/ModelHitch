package com.genoventureslabs.modelhitch.sample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.genoventureslabs.modelhitch.ChatRequest
import com.genoventureslabs.modelhitch.DefaultProviders
import com.genoventureslabs.modelhitch.MessageContent
import com.genoventureslabs.modelhitch.ModelHitch
import com.genoventureslabs.modelhitch.ModelMessage
import com.genoventureslabs.modelhitch.Provider
import com.genoventureslabs.modelhitch.StreamChunk
import com.genoventureslabs.modelhitch.android.AndroidKeyStoreCredentialStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

private const val INITIAL_PROVIDER_ID = "openrouter"

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { ModelHitchSample() }
    }
}

private data class TranscriptMessage(val role: String, val content: String)

@Composable
private fun ModelHitchSample() {
    val context = LocalContext.current
    val keyStore = remember(context) { AndroidKeyStoreCredentialStore(context) }
    val providers = remember { DefaultProviders.all }
    val hitch = remember {
        ModelHitch(
            providers = providers,
            keyStore = keyStore,
        )
    }
    val scope = rememberCoroutineScope()
    val transcript = remember { mutableStateListOf<TranscriptMessage>() }
    var providerId by rememberSaveable { mutableStateOf(INITIAL_PROVIDER_ID) }
    val selectedProvider = providers.first { it.id == providerId }
    var apiKey by rememberSaveable { mutableStateOf("") }
    var model by rememberSaveable { mutableStateOf(selectedProvider.defaultModel) }
    var prompt by rememberSaveable { mutableStateOf("") }
    var status by rememberSaveable { mutableStateOf("") }
    var validation by rememberSaveable { mutableStateOf<String?>(null) }
    var hasSavedKey by rememberSaveable { mutableStateOf(false) }
    var streamJob by remember { mutableStateOf<Job?>(null) }

    LaunchedEffect(providerId) {
        apiKey = ""
        model = selectedProvider.defaultModel
        validation = null
        hasSavedKey = keyStore.get(providerId) != null
    }

    fun saveKey() {
        validation = null
        if (apiKey.isBlank()) {
            validation = "missing-key"
            return
        }
        scope.launch {
            runCatching { keyStore.set(providerId, apiKey.trim()) }
                .onSuccess {
                    apiKey = ""
                    hasSavedKey = true
                    status = "key-saved"
                }
                .onFailure { status = it.message ?: "Storage failed" }
        }
    }

    fun send() {
        validation = when {
            prompt.isBlank() -> "missing-prompt"
            !hasSavedKey && apiKey.isBlank() -> "missing-key"
            else -> null
        }
        if (validation != null) return
        streamJob = scope.launch {
            try {
                if (apiKey.isNotBlank()) {
                    keyStore.set(providerId, apiKey.trim())
                    apiKey = ""
                    hasSavedKey = true
                }
                val sentPrompt = prompt.trim()
                prompt = ""
                transcript += TranscriptMessage("user", sentPrompt)
                transcript += TranscriptMessage("assistant", "")
                status = "streaming"
                hitch.stream(
                    ChatRequest(
                        provider = providerId,
                        model = model.trim(),
                        messages = transcript.dropLast(1).map { message ->
                            if (message.role == "user") {
                                ModelMessage.User(MessageContent.Text(message.content))
                            } else {
                                ModelMessage.Assistant(MessageContent.Text(message.content))
                            }
                        },
                    ),
                ).collect { chunk ->
                    if (chunk is StreamChunk.TextDelta) {
                        val current = transcript.last()
                        transcript[transcript.lastIndex] = current.copy(content = current.content + chunk.text)
                    }
                }
                status = "ready"
            } catch (cancelled: CancellationException) {
                status = "stopped"
                throw cancelled
            } catch (error: Exception) {
                status = error.message ?: "Request failed"
            } finally {
                streamJob = null
            }
        }
    }

    ModelHitchTheme {
        Scaffold(containerColor = MaterialTheme.colorScheme.background) { padding ->
            Column(
                modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp),
            ) {
                Header(status)
                CredentialPanel(
                    providers = providers,
                    selectedProvider = selectedProvider,
                    onProviderChange = { providerId = it.id },
                    apiKey = apiKey,
                    onApiKeyChange = { apiKey = it },
                    model = model,
                    onModelChange = { model = it },
                    hasSavedKey = hasSavedKey,
                    validation = validation,
                    onSave = ::saveKey,
                    onDelete = {
                        scope.launch {
                            keyStore.delete(providerId)
                            hasSavedKey = false
                            status = "key-deleted"
                        }
                    },
                )
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Transcript(transcript, Modifier.weight(1f))
                Composer(
                    prompt = prompt,
                    onPromptChange = { prompt = it },
                    validation = validation,
                    streaming = streamJob != null,
                    onSend = ::send,
                    onStop = { streamJob?.cancel() },
                )
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

@Composable
private fun Header(status: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 22.dp, bottom = 18.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column {
            Text(
                text = stringResource(R.string.app_name),
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Black,
                fontSize = 24.sp,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Text(
                text = stringResource(R.string.app_tagline),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (status.isNotBlank()) {
            Text(
                text = localizedStatus(status),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun CredentialPanel(
    providers: List<Provider>,
    selectedProvider: Provider,
    onProviderChange: (Provider) -> Unit,
    apiKey: String,
    onApiKeyChange: (String) -> Unit,
    model: String,
    onModelChange: (String) -> Unit,
    hasSavedKey: Boolean,
    validation: String?,
    onSave: () -> Unit,
    onDelete: () -> Unit,
) {
    var providerMenuExpanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(bottom = 18.dp)) {
        ExposedDropdownMenuBox(
            expanded = providerMenuExpanded,
            onExpandedChange = { providerMenuExpanded = it },
        ) {
            OutlinedTextField(
                value = selectedProvider.name,
                onValueChange = {},
                modifier = Modifier.fillMaxWidth().menuAnchor(),
                readOnly = true,
                label = { Text(stringResource(R.string.provider)) },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = providerMenuExpanded) },
                singleLine = true,
            )
            ExposedDropdownMenu(
                expanded = providerMenuExpanded,
                onDismissRequest = { providerMenuExpanded = false },
            ) {
                providers.forEach { provider ->
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text(provider.name)
                                Text(
                                    text = provider.id,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        },
                        onClick = {
                            onProviderChange(provider)
                            providerMenuExpanded = false
                        },
                    )
                }
            }
        }
        OutlinedTextField(
            value = apiKey,
            onValueChange = onApiKeyChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text(stringResource(R.string.api_key, selectedProvider.name)) },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            isError = validation == "missing-key",
            supportingText = {
                Text(
                    when {
                        validation == "missing-key" -> stringResource(R.string.missing_key)
                        hasSavedKey -> stringResource(R.string.saved_on_device, selectedProvider.name)
                        else -> stringResource(R.string.key_not_saved, selectedProvider.name)
                    },
                )
            },
        )
        OutlinedTextField(
            value = model,
            onValueChange = onModelChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text(stringResource(R.string.model)) },
            singleLine = true,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onSave, enabled = apiKey.isNotBlank()) {
                Text(stringResource(R.string.save_key))
            }
            TextButton(onClick = onDelete, enabled = hasSavedKey) {
                Text(stringResource(R.string.delete_key))
            }
        }
    }
}

@Composable
private fun Transcript(messages: List<TranscriptMessage>, modifier: Modifier = Modifier) {
    if (messages.isEmpty()) {
        Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.Center) {
            Text(
                text = stringResource(R.string.empty_transcript),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }
    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        items(messages) { message ->
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = stringResource(if (message.role == "user") R.string.you else R.string.assistant),
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = if (message.role == "user") Magenta else Cyan,
                )
                Surface(
                    color = if (message.role == "user") MaterialTheme.colorScheme.surfaceVariant else Color.Transparent,
                    shape = RoundedCornerShape(6.dp),
                ) {
                    Text(
                        text = message.content.ifEmpty { " " },
                        modifier = Modifier.padding(if (message.role == "user") 12.dp else 0.dp),
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
        }
    }
}

@Composable
private fun Composer(
    prompt: String,
    onPromptChange: (String) -> Unit,
    validation: String?,
    streaming: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = prompt,
            onValueChange = onPromptChange,
            modifier = Modifier.weight(1f),
            label = { Text(stringResource(R.string.prompt)) },
            isError = validation == "missing-prompt",
            supportingText = if (validation == "missing-prompt") {
                { Text(stringResource(R.string.missing_prompt)) }
            } else null,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { if (!streaming) onSend() }),
            maxLines = 4,
        )
        Button(
            onClick = if (streaming) onStop else onSend,
            colors = ButtonDefaults.buttonColors(
                containerColor = if (streaming) Magenta else Green,
                contentColor = Ink,
            ),
        ) {
            Text(stringResource(if (streaming) R.string.stop else R.string.send))
        }
    }
}

@Composable
private fun localizedStatus(status: String): String = when (status) {
    "ready" -> stringResource(R.string.ready)
    "streaming" -> stringResource(R.string.streaming)
    "stopped" -> stringResource(R.string.stopped)
    "key-saved" -> stringResource(R.string.key_saved)
    "key-deleted" -> stringResource(R.string.key_deleted)
    else -> status
}

@Composable
private fun ModelHitchTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Color(0xFF4D7D00),
            secondary = Magenta,
            tertiary = Cyan,
            background = Color(0xFFF7F8F5),
            surface = Color.White,
            surfaceVariant = Color(0xFFE9ECE6),
            onBackground = Ink,
            onSurface = Ink,
            outline = Color(0xFF72786E),
            outlineVariant = Color(0xFFD5D9D1),
        ),
        content = content,
    )
}

private val Green = Color(0xFF8BD600)
private val Magenta = Color(0xFFCC3F88)
private val Cyan = Color(0xFF087F91)
private val Ink = Color(0xFF171A16)