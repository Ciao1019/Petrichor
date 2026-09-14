package documentparse

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/rc4"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func testRuntimeEncryptedPDF(t *testing.T, ctx context.Context, cfg Config) {
	t.Helper()
	const userPassword, ownerPassword = "offline-user", "offline-owner"
	source := runtimeEncryptedBlankPDF(t, userPassword, ownerPassword)
	dir := t.TempDir()
	input := filepath.Join(dir, "encrypted.pdf")
	if err := os.WriteFile(input, source, 0600); err != nil {
		t.Fatal(err)
	}
	// 正确的用户/所有者密码都能真正打开，排除靠损坏 Encrypt 字典伪造的 fixture。
	for _, credentials := range [][]string{{"-upw", userPassword}, {"-opw", ownerPassword}} {
		data, err := (execRunner{}).run(ctx, "pdfinfo", dir, append(credentials, input), maxToolOutput)
		if err != nil {
			t.Fatalf("合法加密 fixture 使用正确密码应能打开: %v", err)
		}
		_, err = parsePDFInfo(data)
		mustCode(t, err, CodeEncrypted)
	}
	_, err := (execRunner{}).run(ctx, "pdfinfo", dir, []string{input}, maxToolOutput)
	mustCode(t, popplerError(err), CodeEncrypted)
	work := t.TempDir()
	err = Prepare(ctx, cfg, "encrypted.pdf", source, work, nil, noEmit(t))
	mustCode(t, err, CodeEncrypted)
	if !IsPermanent(err) {
		t.Fatal("打开密码错误应永久失败")
	}
	runtimeAssertClean(t, work)
}

// 仅测试 PDF Standard Security Handler R2/V1（40-bit RC4），不可用于保护真实数据。
// 文档只有一个无字符串/流的空白页；O、U、ID 与 xref 均按规范生成，无外部 fixture。
func runtimeEncryptedBlankPDF(t *testing.T, userPassword, ownerPassword string) []byte {
	t.Helper()
	padding := []byte{
		0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
		0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
		0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
		0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
	}
	pad := func(password string) []byte {
		data := append([]byte(password), padding...)
		return data[:32]
	}
	crypt := func(key, data []byte) []byte {
		cipher, err := rc4.NewCipher(key)
		if err != nil {
			t.Fatal(err)
		}
		out := make([]byte, len(data))
		cipher.XORKeyStream(out, data)
		return out
	}
	ownerHash := md5.Sum(pad(ownerPassword))
	owner := crypt(ownerHash[:5], pad(userPassword))
	id := md5.Sum([]byte("documentparse offline encrypted blank PDF"))
	keyInput := append(pad(userPassword), owner...)
	keyInput = append(keyInput, 0xfc, 0xff, 0xff, 0xff) // P = -4，little endian。
	keyInput = append(keyInput, id[:]...)
	keyHash := md5.Sum(keyInput)
	user := crypt(keyHash[:5], padding)
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
		fmt.Sprintf("<< /Filter /Standard /V 1 /R 2 /Length 40 /O <%x> /U <%x> /P -4 >>", owner, user),
	}
	var buf bytes.Buffer
	buf.WriteString("%PDF-1.4\n")
	offsets := []int{0}
	for i, object := range objects {
		offsets = append(offsets, buf.Len())
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", i+1, object)
	}
	xref := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&buf, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root 1 0 R /Encrypt 4 0 R /ID [<%x> <%x>] >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), id, id, xref)
	return buf.Bytes()
}
